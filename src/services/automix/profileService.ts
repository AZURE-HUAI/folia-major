import type { SongResult } from '../../types';
import { getPlaybackSongKey, getPlaybackSourceRef } from '../../utils/appPlaybackGuards';
import { saveAudioBlob } from '../audioCache';
import { getFromCache, saveToCache } from '../db';
import { getCachedSongAudioBlob } from '../onlineMusic/resourceCache';
import { getSongResourceCacheKey } from '../onlineMusic/resourceKeys';
import { analyseTrack, PROFILE_SAMPLE_RATE, TRACK_PROFILE_VERSION, type TrackProfile } from './trackProfile';

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

/** Averages to mono, which is what every measurement here wants and a quarter of the memory. */
const toMono = (buffer: AudioBuffer): Float32Array => {
    const mono = new Float32Array(buffer.length);
    for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
        const data = buffer.getChannelData(channel);
        for (let index = 0; index < mono.length; index += 1) mono[index] += data[index];
    }
    if (buffer.numberOfChannels > 1) {
        for (let index = 0; index < mono.length; index += 1) mono[index] /= buffer.numberOfChannels;
    }
    return mono;
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

/** Either the bytes, or the reason there are none - which is the more useful answer most days. */
type BytesResult = { bytes: ArrayBuffer } | { skipped: string };

const readBytes = async ({ song, audioUrl, enableMediaCache }: ProfileRequest): Promise<BytesResult> => {
    const cached = await getCachedSongAudioBlob(song);
    if (cached) return { bytes: await cached.arrayBuffer() };

    if (!audioUrl) return { skipped: 'not cached yet and no URL to read it from' };
    // A blob: or file: URL is already on this machine, so reading it is free whatever the setting
    // says. Anything else is a real download and needs the cache to justify it.
    const isLocal = audioUrl.startsWith('blob:') || audioUrl.startsWith('file:')
        || getPlaybackSourceRef(song).kind !== 'online';
    if (!isLocal && !enableMediaCache) {
        return { skipped: 'song caching is off, so analysing would mean an extra download' };
    }

    try {
        const blob = await (await fetch(audioUrl)).blob();
        if (!isLocal) {
            // The same write the audio bridge would have done after playback. Fetching once and
            // feeding both is the whole reason this is allowed to run at all.
            await saveAudioBlob(getSongResourceCacheKey('audio', song), blob);
        }
        return { bytes: await blob.arrayBuffer() };
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
            if (stored?.version === TRACK_PROFILE_VERSION) {
                remember(songKey, stored);
                return;
            }

            const result = await readBytes(request);
            if ('skipped' in result) {
                // Once per track, not once per prefetch pass. Without this the feature can sit
                // completely inert - every transition falling through to the plain crossfade -
                // and print nothing at all to say why.
                if (skipped.get(songKey) !== result.skipped) {
                    skipped.set(songKey, result.skipped);
                    console.log(`[Automix] not analysing "${request.song.name}": ${result.skipped}`);
                }
                return;
            }
            skipped.delete(songKey);

            const buffer = await decodeAtProfileRate(result.bytes);
            const profile = buffer ? await analyseTrack(toMono(buffer), buffer.sampleRate) : null;
            remember(songKey, profile);
            if (profile) {
                await saveToCache(storageKey(songKey), profile);
                console.log(
                    `[Automix] analysed "${request.song.name}":`
                    + ` ${profile.bpm ? `${Math.round(profile.bpm)} BPM, ` : ''}`
                    + `${profile.loudness.toFixed(1)} dBFS,`
                    + ` lead-in ${profile.leadIn.toFixed(2)}s,`
                    + ` ${profile.startsHot ? 'starts hot' : 'has an intro'},`
                    + ` ${profile.endsHot ? 'ends hot' : 'decays out'}`,
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

/** Drops the in-memory side. The stored profiles stay: they describe the file, not the session. */
export const clearTrackProfileRuntime = () => {
    profiles.clear();
    inFlight.clear();
    skipped.clear();
};
