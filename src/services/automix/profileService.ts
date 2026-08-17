import type { SongResult } from '../../types';
import { getPlaybackSongKey, getPlaybackSourceRef } from '../../utils/appPlaybackGuards';
import { saveAudioBlob } from '../audioCache';
import { getFromCache, saveToCache } from '../db';
import { getCachedSongAudioBlob } from '../onlineMusic/resourceCache';
import { getSongResourceCacheKey } from '../onlineMusic/resourceKeys';
import {
    analyseTrack,
    measureEdges,
    PROFILE_SAMPLE_RATE,
    TRACK_PROFILE_VERSION,
    type TrackProfile,
} from './trackProfile';

// src/services/automix/profileService.ts
// Gets the bytes of a track that has not been played yet, measures it once, and remembers the
// answer. The impure half of the evidence layer; the maths is in trackProfile.ts.
//
// The rule about bandwidth is the important one here. Analysis needs the whole file, and a music
// player that quietly downloads every upcoming track to sound slightly better is not a trade
// anyone agreed to. So bytes are only ever taken from somewhere they were going to come from
// anyway: the media cache when it already holds the track, a local file, or - when song caching is
// switched on - the one download that would have happened after playback, moved earlier and
// written to the same cache. With caching off, an online track is simply not analysed and the
// blend falls back to the live measurement of the outgoing deck.

const profiles = new Map<string, TrackProfile | null>();
const inFlight = new Set<string>();
/**
 * Tracks whose bytes were not reachable this time round.
 *
 * Deliberately NOT stored as a null profile: "no bytes yet" is a passing condition - the media
 * cache fills up as tracks finish playing - while a failed decode is permanent. Recording the two
 * the same way meant a track skipped once was never looked at again for the rest of the session.
 * Kept only to log the reason once per track instead of on every prefetch pass.
 */
const skipped = new Map<string, string>();
/** Same order of magnitude as the prefetch cache; each entry is a couple of hundred bytes. */
const MAX_PROFILES = 200;

/** One at a time: decoding a track allocates tens of megabytes, and two at once is the spike. */
let queue: Promise<unknown> = Promise.resolve();

const storageKey = (songKey: string) => `automix_profile_${songKey}`;

const remember = (songKey: string, profile: TrackProfile | null) => {
    profiles.delete(songKey);
    profiles.set(songKey, profile);
    while (profiles.size > MAX_PROFILES) {
        const oldest = profiles.keys().next().value;
        if (oldest === undefined) break;
        profiles.delete(oldest);
    }
};

/** What the planner reads. Synchronous on purpose: a plan cannot wait on a decode. */
export const getTrackProfile = (song: SongResult | null | undefined): TrackProfile | null => (
    song ? profiles.get(getPlaybackSongKey(song)) ?? null : null
);

/**
 * Splits the decode into mid and side.
 *
 * Mid - (L+R)/2 - is the mono sum every other measurement here wants. Side - (L-R)/2 - is what is
 * left when the two channels cancel, which is everything the mix placed off-centre. Keeping it is
 * what makes a voice findable: lead vocals are panned dead centre on essentially every commercial
 * master, so they live almost entirely in mid and almost not at all in side. Cancelling one against
 * the other is the same arithmetic karaoke machines have used to drop the lead vocal for decades.
 *
 * Null side for a mono file: there are no two channels to cancel, so the question cannot be asked.
 */
const toMidSide = (buffer: AudioBuffer): { mid: Float32Array; side: Float32Array | null } => {
    const left = buffer.getChannelData(0);
    if (buffer.numberOfChannels < 2) return { mid: Float32Array.from(left), side: null };

    const right = buffer.getChannelData(1);
    const mid = new Float32Array(buffer.length);
    const side = new Float32Array(buffer.length);
    for (let index = 0; index < mid.length; index += 1) {
        mid[index] = (left[index] + right[index]) / 2;
        side[index] = (left[index] - right[index]) / 2;
    }
    return { mid, side };
};

/**
 * Decodes straight to the analysis rate.
 *
 * decodeAudioData resamples to the context's own sample rate, so a context created at 22.05kHz
 * does the downsampling in the decoder - no render pass, no resampler here, and a four-minute
 * track lands as ~10MB of floats instead of ~80MB.
 */
const decodeAtProfileRate = async (bytes: ArrayBuffer): Promise<AudioBuffer | null> => {
    const OfflineContext = window.OfflineAudioContext
        || (window as Window & { webkitOfflineAudioContext?: typeof OfflineAudioContext }).webkitOfflineAudioContext;
    if (!OfflineContext) return null;
    try {
        return await new OfflineContext(1, 1, PROFILE_SAMPLE_RATE).decodeAudioData(bytes);
    } catch (error) {
        console.warn('[Automix] could not decode a track for analysis', error);
        return null;
    }
};

interface ProfileRequest {
    song: SongResult;
    /** Where the bytes could be fetched from, when they are not already cached. */
    audioUrl?: string | null;
    /** Song caching is on, so downloading this track now costs nothing it was not going to cost. */
    enableMediaCache: boolean;
}

/**
 * How much of the front of a track to read when the whole file is off limits.
 *
 * Enough for the head-side evidence at any bitrate this player deals with: about 40 seconds at
 * 320kbps and a minute and a half at 128, which comfortably covers the leading silence, whether
 * the track opens at full level, the intro's shape, a tempo and a key. Roughly a tenth of a
 * typical track rather than all of it.
 */
const PREFIX_BYTES = 1_572_864;

/** Either the bytes, or the reason there are none - which is the more useful answer most days. */
type BytesResult =
    | { bytes: ArrayBuffer; partial: boolean }
    | { skipped: string };

/**
 * Reads only the front of a file, and only if the server will genuinely serve only the front.
 *
 * A range off the END would be the more useful half - it is the outgoing track's tail that decides
 * most transitions - but it is not decodable: strip a file's container header and no decoder will
 * touch what is left. A range off the front keeps the header, so it decodes as a short track.
 *
 * If the server ignores the Range header it answers 200 with the whole file, which is exactly the
 * download this path exists to avoid, so the body is cancelled rather than used.
 */
const readPrefix = async (audioUrl: string): Promise<BytesResult> => {
    const response = await fetch(audioUrl, { headers: { Range: `bytes=0-${PREFIX_BYTES - 1}` } });
    if (response.status !== 206) {
        await response.body?.cancel();
        return { skipped: 'the server would not serve a partial range, and a full download is not ours to spend' };
    }
    return { bytes: await response.arrayBuffer(), partial: true };
};

const readBytes = async (
    { song, audioUrl, enableMediaCache }: ProfileRequest,
    /** A head-only profile is already stored, so there is nothing a second range request buys. */
    hasStoredPartial: boolean,
): Promise<BytesResult> => {
    const cached = await getCachedSongAudioBlob(song);
    if (cached) return { bytes: await cached.arrayBuffer(), partial: false };

    if (!audioUrl) return { skipped: 'not cached yet and no URL to read it from' };
    // A blob: or file: URL is already on this machine, so reading it is free whatever the setting
    // says. Anything else is a real download and needs a reason.
    const isLocal = audioUrl.startsWith('blob:') || audioUrl.startsWith('file:')
        || getPlaybackSourceRef(song).kind !== 'online';

    try {
        if (!isLocal && !enableMediaCache) {
            // Song caching is off, so the full file would be bandwidth nobody agreed to. Take the
            // front of it instead: less than the transition is worth, and it still answers the
            // questions about how this track STARTS - which is what the chooser needs from the
            // track it is blending into.
            if (hasStoredPartial) return { skipped: '' };
            return await readPrefix(audioUrl);
        }

        const blob = await (await fetch(audioUrl)).blob();
        if (!isLocal) {
            // The same write the audio bridge would have done after playback. Fetching once and
            // feeding both is the whole reason a full read is allowed here at all.
            await saveAudioBlob(getSongResourceCacheKey('audio', song), blob);
        }
        return { bytes: await blob.arrayBuffer(), partial: false };
    } catch (error) {
        console.warn('[Automix] could not read a track for analysis', error);
        return { skipped: 'the download failed' };
    }
};

/**
 * Measures a track if it has not been measured yet. Safe to call repeatedly.
 *
 * Every outcome is remembered, failures included: a track that cannot be analysed - no bytes, an
 * unsupported codec - must not be retried on every pass of the prefetcher.
 */
export const ensureTrackProfile = async (request: ProfileRequest): Promise<void> => {
    const songKey = getPlaybackSongKey(request.song);
    if (profiles.has(songKey) || inFlight.has(songKey)) return;
    inFlight.add(songKey);

    queue = queue.then(async () => {
        try {
            const stored = await getFromCache<TrackProfile>(storageKey(songKey));
            const usable = stored?.version === TRACK_PROFILE_VERSION ? stored : null;
            // A complete profile is the end of it. A head-only one is worth revisiting: the track
            // may have finished playing since and be sitting in the media cache now, in which case
            // the tail - the half that decides most transitions - is finally readable.
            if (usable && !usable.partial) {
                remember(songKey, usable);
                return;
            }

            const result = await readBytes(request, Boolean(usable?.partial));
            if ('skipped' in result) {
                if (usable) {
                    remember(songKey, usable);
                    return;
                }
                // Once per track, not once per prefetch pass. Without this the feature can sit
                // completely inert - every transition falling through to the plain crossfade -
                // and print nothing at all to say why.
                if (result.skipped && skipped.get(songKey) !== result.skipped) {
                    skipped.set(songKey, result.skipped);
                    console.log(`[Automix] not analysing "${request.song.name}": ${result.skipped}`);
                }
                return;
            }
            skipped.delete(songKey);

            const buffer = await decodeAtProfileRate(result.bytes);
            const channels = buffer ? toMidSide(buffer) : null;
            const profile = buffer && channels
                ? await analyseTrack(channels.mid, buffer.sampleRate, {
                    partial: result.partial,
                    side: channels.side,
                })
                : null;
            remember(songKey, profile);
            if (profile) {
                await saveToCache(storageKey(songKey), profile);
                // The analysed length is printed for the partial case on purpose: "nothing found"
                // and "nothing found in the twelve seconds we were allowed to read" look identical
                // in every other field, and only one of them says the measurement is wrong.
                const at = (seconds: number | null) => (seconds === null ? 'none' : `${seconds.toFixed(2)}s`);
                console.log(
                    `[Automix] analysed "${request.song.name}"`
                    + `${profile.partial ? ` (head only, ${profile.duration.toFixed(1)}s of it)` : ''}:`
                    + ` ${profile.bpm ? `${Math.round(profile.bpm)} BPM, ` : ''}`
                    + `${profile.loudness.toFixed(1)} dBFS,`
                    + ` lead-in ${profile.leadIn.toFixed(2)}s,`
                    + ` section ${at(profile.sectionStart)}, voice ${at(profile.vocalStart)},`
                    + ` ${profile.startsHot ? 'starts hot' : 'has an intro'}`
                    + `${profile.endsHot === null ? '' : `, ${profile.endsHot ? 'ends hot' : 'decays out'}`}`,
                );
            }
        } catch (error) {
            console.warn('[Automix] track analysis failed', error);
            remember(songKey, null);
        } finally {
            inFlight.delete(songKey);
        }
    });

    await queue;
};

/** Within this fraction of the track's length, the deck played it from one end to the other. */
const PLAYED_THROUGH_TOLERANCE = 0.05;

/**
 * Completes a head-only profile from the deck's own readings, once a track has played out.
 *
 * This is the only way the END of an uncached track is ever knowable. A range request off the tail
 * is not decodable - see readPrefix - so with song caching off the analysis can only ever describe
 * how a track STARTS, which leaves `endsHot` and `outroSlope` null and takes three of the five
 * transition styles permanently off the table. The bytes it needs are not missing though: they go
 * past the deck on the way to the speakers, and the analyser tap already reads a level off every
 * frame of them. So the half a download cannot reach is measured on the first listen instead, and
 * the couple of hundred bytes it produces are kept - the audio itself is not.
 *
 * It converges over a rotation rather than working the first time, which is inherent: nothing can
 * know how a song ends before hearing it end.
 */
export const recordPlayedTail = (
    song: SongResult,
    levels: readonly number[],
    hopSec: number,
    /** The track's real length, to check these readings actually span it. */
    duration: number,
): void => {
    const songKey = getPlaybackSongKey(song);
    const known = profiles.get(songKey);
    if (!known || !known.partial) return;
    // A seek leaves the history covering some other span than the file, and a level series that
    // starts in the middle of a track describes a fade-out that never happened.
    if (!Number.isFinite(duration) || duration <= 0) return;
    if (Math.abs(levels.length * hopSec - duration) > duration * PLAYED_THROUGH_TOLERANCE) return;

    const edges = measureEdges(levels, hopSec);
    if (!edges) return;

    const profile: TrackProfile = {
        ...known,
        partial: false,
        duration,
        leadOut: Math.max(0, duration - edges.soundingEnd),
        endsHot: edges.endsHot,
        outroSlope: edges.outroSlope,
        // Measured over the whole track rather than the head, so it supersedes the stored one.
        loudness: edges.loudness,
    };
    remember(songKey, profile);
    void saveToCache(storageKey(songKey), profile);
    console.log(
        `[Automix] heard out "${song.name}": ${edges.loudness.toFixed(1)} dBFS,`
        + ` ${edges.endsHot ? 'ends hot' : 'decays out'} (${edges.outroSlope.toFixed(2)} dB/s)`,
    );
};

/** Drops the in-memory side. The stored profiles stay: they describe the file, not the session. */
export const clearTrackProfileRuntime = () => {
    profiles.clear();
    inFlight.clear();
    skipped.clear();
};
