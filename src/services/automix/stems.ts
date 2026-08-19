import type { SongResult } from '../../types';
import { getPlaybackSongKey, getPlaybackSourceRef } from '../../utils/appPlaybackGuards';
import { getCachedSongAudioBlob } from '../onlineMusic/resourceCache';
import { canRunBeatThis } from './beatThis';
import { profilesSettled } from './profileService';

// src/services/automix/stems.ts
// Separated audio for the two ends of a transition: the outgoing track's tail and the incoming
// track's head, four stems each, ready to be played as buffers.
//
// This is the "material" half of automix and the reason the round-eleven vocal exit can exist at
// all. Everything the planner decides about WHEN is useless for that rule without a stream carrying
// only the voice, because a finished master offers no way to take a voice out of itself.
//
// Two rules keep it honest about cost:
//
// Bytes are never downloaded for this. Only a track already sitting in the media cache, or a local
// file, is separated - the same rule profileService follows, and stricter, because separation is
// worth less than a download nobody agreed to. A track that is not local simply has no stems and
// the transition falls back to the master crossfade, which is what every build before this did.
//
// Only a WINDOW is separated, never a whole track. A four-minute track is a minute of CPU and a
// third of a gigabyte of stems; the last thirty seconds is eight seconds and forty megabytes, and
// no transition has ever needed more than the last thirty seconds.

export type StemName = 'drums' | 'bass' | 'other' | 'vocals';
export const STEM_NAMES: readonly StemName[] = ['drums', 'bass', 'other', 'vocals'];

/** The rate htdemucs is bound to. Not a preference - the export has it baked in. */
export const STEM_SAMPLE_RATE = 44100;

/**
 * How much of a track's end (or start) is separated.
 *
 * Comfortably past the longest overlap the planner can ask for (25s), with room in front for the
 * placement search to look at. Also the memory bound: four stereo stems at 44.1kHz is 1.4MB per
 * second, so this window is 42MB and a transition holds two of them.
 */
export const STEM_WINDOW_SEC = 30;

/** Which end of a track a window came from. A track needs both over its life, never at once. */
export type StemRole = 'head' | 'tail';

export interface TrackStems {
    /** Media time of the window's first sample. Everything in `buffers` is relative to this. */
    from: number;
    duration: number;
    role: StemRole;
    /** One stereo buffer per stem. They sum back to the mix exactly - see `other` below. */
    buffers: Record<StemName, AudioBuffer>;
}

/**
 * Once the separator has declined it is not asked again for the rest of the session.
 *
 * The ways it declines - not Electron, no weights, runtime failed to start - are all permanent for
 * the life of the process, and retrying would put a failed native load in front of every track.
 */
let declined = false;
export const stemsDeclined = () => declined;

/** Whether this build can separate at all. What the settings page reads to explain itself. */
export const canSeparateStems = (): boolean =>
    !declined && typeof window !== 'undefined' && typeof window.electron?.separateStems === 'function';

const cache = new Map<string, TrackStems>();
const inFlight = new Set<string>();
/**
 * How many windows are kept.
 *
 * Three: the outgoing track's tail, the incoming track's head, and one spare so the track that just
 * arrived does not lose its head window the moment the next one is requested. Each is 42MB, so this
 * is the single largest thing automix holds and the number is a memory budget, not a hit rate.
 */
const MAX_WINDOWS = 3;

const keyOf = (song: SongResult, role: StemRole) => `${getPlaybackSongKey(song)}:${role}`;

/**
 * Says why a window was not separated, once per window rather than once per render.
 *
 * The effect that asks for separation re-runs on several props, and a reason printed every time
 * would bury the transition lines it is meant to sit beside. Once is enough to answer "why is this
 * silent", which is the only question it exists for.
 */
const explained = new Set<string>();
const explainOnce = (key: string, message: string) => {
    if (explained.has(key)) return;
    explained.add(key);
    console.log(message);
};

/** Tail of the separation queue; see the gate in `ensureStems` for why one window at a time. */
let queue: Promise<void> = Promise.resolve();

/**
 * The two windows a transition would use right now. See `remember` for why eviction needs them.
 *
 * A set of keys rather than a pair of songs, because that is all the eviction question needs and
 * it keeps this file from having an opinion about what a queue is.
 */
let wanted = new Set<string>();

/** The key a window is cached under, so a caller can name the pair it still needs. */
export const stemWindowKey = (song: SongResult, role: StemRole) => keyOf(song, role);

/** Names the pair the next transition would use. Anything else becomes evictable. */
export const setWantedStems = (keys: readonly string[]) => { wanted = new Set(keys); };

/**
 * Which window to drop when the budget is full: the oldest one NOBODY IS WAITING ON.
 *
 * Age alone gets this exactly backwards, and it was measured doing so. Separation for a transition
 * the listener had already skipped away from finished twenty seconds later, and storing that dead
 * result evicted the tail of the track playing at that moment - the one window the next transition
 * was certain to ask for. That transition then fell back to the crossfade without even
 * re-separating, because the other half of the pair was still cached.
 *
 * The budget was never the problem. Three slots hold a pair plus a spare, which is what the comment
 * on MAX_WINDOWS has always claimed. What it could not survive was throwing the pair away to make
 * room for the spare.
 *
 * Falls back to the oldest when everything is wanted, so a stale or empty `wanted` degrades to the
 * plain LRU this replaced rather than to nothing being evictable.
 */
export const pickStemVictim = (
    keys: readonly string[],
    stillWanted: ReadonlySet<string>,
): string | undefined => keys.find(key => !stillWanted.has(key)) ?? keys[0];

const remember = (key: string, value: TrackStems) => {
    cache.delete(key);
    cache.set(key, value);
    while (cache.size > MAX_WINDOWS) {
        const victim = pickStemVictim([...cache.keys()], wanted);
        if (victim === undefined) break;
        cache.delete(victim);
    }
};

/**
 * Read a window and mark it as used.
 *
 * Re-keyed on READ and not only on write, or "least recently used" means "least recently
 * separated": a window read by every transition still ages out behind one nobody has touched
 * since it arrived.
 */
const touch = (key: string): TrackStems | null => {
    const found = cache.get(key);
    if (!found) return null;
    cache.delete(key);
    cache.set(key, found);
    return found;
};

/** What the planner and the scheduler read. Synchronous: a transition cannot wait on a decode. */
export const getStems = (song: SongResult | null | undefined, role: StemRole): TrackStems | null =>
    (song ? touch(keyOf(song, role)) : null);

/**
 * The same lookup, by playback key rather than by song.
 *
 * What the session uses, and the distinction is the whole bug this replaced. A gesture is scheduled
 * AFTER the app has advanced, so `currentSong` is already the incoming track by then; asking for
 * "the current song's tail" at that moment asks for the tail of a track that has not ended and the
 * head of one that is not playing, and neither has been separated. The session already pins both
 * identities at arm time - `plannedFromKey` and `plannedNextKey`, the same keys this cache is
 * built from - so it can name the pair instead of re-deriving it from a value that has moved on.
 *
 * Still read late, which was the reason the old lookup was a function: separation finishes on its
 * own clock and a window that lands between the plan and the gesture is still worth using. Late is
 * the property worth keeping; re-deriving WHICH pair was never part of it.
 */
export const getStemsByKey = (key: string | null, role: StemRole): TrackStems | null =>
    (key ? touch(`${key}:${role}`) : null);

/**
 * The bytes, but only if having them costs nothing.
 *
 * Deliberately narrower than profileService's version, which is allowed to move a download earlier.
 * Separation is not worth a byte of anyone's bandwidth, so this reads the media cache and local
 * files and gives up otherwise.
 */
const readLocalBytes = async (
    song: SongResult,
    audioUrl: string | null | undefined,
): Promise<ArrayBuffer | null> => {
    const cached = await getCachedSongAudioBlob(song);
    if (cached) return cached.arrayBuffer();
    if (!audioUrl) return null;
    const isLocal = audioUrl.startsWith('blob:') || audioUrl.startsWith('file:')
        || getPlaybackSourceRef(song).kind !== 'online';
    if (!isLocal) return null;
    try {
        return await (await fetch(audioUrl)).arrayBuffer();
    } catch {
        return null;
    }
};

export interface StemRequest {
    song: SongResult;
    role: StemRole;
    /** Used only when it is a local URL; an online one is left alone. */
    audioUrl?: string | null;
    /** The live context, so the buffers are built at its rate and can be played without a copy. */
    context: AudioContext;
    /**
     * Whether this window is still the one a transition is coming for, asked just before the model.
     *
     * A request can sit in the queue for a minute, and a listener skipping through an album leaves
     * a trail of pairs nobody will ever hear. Nothing here could cancel, so the worker went on
     * separating an abandoned album while the one now playing waited behind it - measured: two
     * tracks from a playlist the listener had already left were still being separated and profiled
     * twenty seconds after they left it.
     */
    stillWanted?: () => boolean;
}

/**
 * Separates one window of one track if it has not been separated yet. Safe to call repeatedly.
 *
 * Fire and forget from the caller's point of view: nothing waits on this, and a transition that
 * arrives before it finishes simply uses the master crossfade. That is the whole failure mode, and
 * it is the behaviour every build before stems existed had.
 */
export const ensureStems = async (request: StemRequest): Promise<void> => {
    if (!canSeparateStems()) return;
    const key = keyOf(request.song, request.role);
    if (cache.has(key) || inFlight.has(key)) return;
    inFlight.add(key);
    // After the cache and in-flight guards, so this is once per window rather than once per render.
    //
    // "Asked for" and "asked for and gave up" look identical without it, and only one of them is a
    // bug in this file - which is the exact confusion that let the gesture never run for its whole
    // life. Every way out below this line says why; this line is what makes their absence mean
    // something. The first track of a session having no line here at all is the case to watch.
    console.log(`[Automix] separating the ${request.role} of "${request.song.name}"`);

    // One window at a time, for profileService's reason and for one of its own.
    //
    // Its own: the inference worker serialises anyway, so two windows in flight only means the
    // second one WAITS INSIDE its own measurement. That is not a harmless cosmetic error - it is
    // the number the whole "can a weaker machine run this" question rests on, and unserialised it
    // read 23.4s for a window whose model time was 9.5s, which is the difference between three
    // times realtime and not keeping up at all. A measurement taken around a queue measures the
    // queue. Holding the slot here means the timer below starts when the work does.
    const ahead = queue;
    let release = () => { };
    queue = new Promise<void>(resolve => { release = resolve; });

    try {
        await ahead;
        // Behind every profile queued so far - see `profilesSettled` for why that order and not the
        // other one. Held before the decode as well as the model, because the decode is tens of
        // megabytes on the same main thread the profile's own decode wants.
        await profilesSettled();

        const started = performance.now();
        const bytes = await readLocalBytes(request.song, request.audioUrl);
        if (!bytes) {
            explainOnce(key, `[Automix] not separating the ${request.role} of "${request.song.name}":`
                + ' the file is not in the media cache');
            return;
        }

        // Decoded at the model's rate rather than the context's, because the model's rate is not
        // negotiable and resampling twice to land back where we started would only add error.
        const OfflineContext = window.OfflineAudioContext;
        if (!OfflineContext) return;
        let decoded: AudioBuffer;
        try {
            decoded = await new OfflineContext(1, 1, STEM_SAMPLE_RATE).decodeAudioData(bytes);
        } catch (error) {
            console.warn('[Automix] could not decode a track for separation', error);
            return;
        }

        const total = decoded.length;
        const windowLength = Math.min(total, Math.round(STEM_WINDOW_SEC * STEM_SAMPLE_RATE));
        const start = request.role === 'tail' ? total - windowLength : 0;
        const left = decoded.getChannelData(0).slice(start, start + windowLength);
        const right = decoded.numberOfChannels > 1
            ? decoded.getChannelData(1).slice(start, start + windowLength)
            : left.slice();

        const separate = window.electron?.separateStems;
        if (!separate) return;
        // Last check before the expensive part: the wait above and the decode below it are long
        // enough for the listener to have moved on twice. Returning here leaves nothing cached and
        // clears `inFlight`, so coming back to this track asks again rather than finding a hole.
        if (request.stillWanted && !request.stillWanted()) {
            console.log(`[Automix] dropped the ${request.role} of "${request.song.name}":`
                + ' no longer the pair a transition is coming for');
            return;
        }
        const modelStarted = performance.now();
        const parts = await separate({ left, right });
        if (!parts) {
            declined = true;
            console.warn('[Automix] separation is unavailable in this build; every transition will'
                + ' use the master crossfade');
            return;
        }

        const buffers = {} as Record<StemName, AudioBuffer>;
        const make = (l: Float32Array<ArrayBuffer>, r: Float32Array<ArrayBuffer>) => {
            const buffer = request.context.createBuffer(2, windowLength, STEM_SAMPLE_RATE);
            buffer.copyToChannel(l, 0);
            buffer.copyToChannel(r, 1);
            return buffer;
        };
        for (const name of ['drums', 'bass', 'vocals'] as const) {
            buffers[name] = make(parts[name].left, parts[name].right);
        }
        // `other` by SUBTRACTION rather than as a fourth model output, which is what the listening
        // harness did for eleven rounds and is not a shortcut. htdemucs is trained to reconstruct
        // but does not guarantee it: measured on a real track its four rows sum back to the mix
        // only within -31 dB. Deriving the fourth makes the sum exact by construction, so a window
        // with every stem at unity is bit-identical to the master - which matters because that is
        // precisely the state the deck is in at the moment it splices over from the element.
        const otherL = new Float32Array(windowLength);
        const otherR = new Float32Array(windowLength);
        for (let i = 0; i < windowLength; i += 1) {
            otherL[i] = left[i] - parts.drums.left[i] - parts.bass.left[i] - parts.vocals.left[i];
            otherR[i] = right[i] - parts.drums.right[i] - parts.bass.right[i] - parts.vocals.right[i];
        }
        buffers.other = make(otherL, otherR);

        remember(key, {
            from: start / STEM_SAMPLE_RATE,
            duration: windowLength / STEM_SAMPLE_RATE,
            role: request.role,
            buffers,
        });
        // The two costs, printed separately and on purpose.
        //
        // This is the only number that says whether the feature is viable on a machine that is not
        // the one it was written on. The window is thirty seconds of audio, so anything near or
        // above thirty here means separation is not keeping ahead of playback and a listener will
        // mostly hear the crossfade - and nobody can tune the thread count for hardware they cannot
        // measure. A log that carries it turns any user's paste into a measurement.
        const modelSec = (performance.now() - modelStarted) / 1000;
        const totalSec = (performance.now() - started) / 1000;
        console.log(`[Automix] separated the ${request.role} of "${request.song.name}"`
            + ` (${(windowLength / STEM_SAMPLE_RATE).toFixed(1)}s from ${(start / STEM_SAMPLE_RATE).toFixed(1)}s)`
            + ` - ${modelSec.toFixed(1)}s in the model, ${totalSec.toFixed(1)}s with the decode`);
    } catch (error) {
        console.warn('[Automix] separation failed', error);
    } finally {
        inFlight.delete(key);
        // Unconditionally, including after a throw: a slot never handed back stalls every window
        // for the rest of the session, and the failure mode is the subsystem going quiet forever.
        release();
    }
};

/** Drops every window. The stems describe a file, but they are far too large to keep. */
export const clearStems = () => {
    cache.clear();
    inFlight.clear();
};

/**
 * Which of the two builds this is.
 *
 * The desktop app and the web app run the SAME planner over different evidence, and that is a
 * design decision rather than a limitation: everything needing a native runtime - the beat grid
 * from Beat This!, the four stems from htdemucs - lives in the Electron main process, so the
 * browser build simply never gets an answer and falls through to the estimators and the master
 * crossfade it always had. Nothing is disabled and nothing throws; the same code takes a different
 * branch because it was handed less.
 *
 * Lives here rather than in transitionStrategy, which would be its natural home, because that
 * module is imported by the settings STORE and this one reaches the media cache: the edge
 * transitionStrategy -> stems -> resourceCache -> audioCache -> useSettingsUiStore closes a real
 * cycle, and the symptom is not a warning but `DEFAULT_TRANSITION_SETTINGS` being undefined while
 * the store initialises. Kept out of that graph on purpose.
 */
export interface TransitionCapabilities {
    /** Bar lines from the model rather than from the built-in estimator. */
    beatGrid: boolean;
    /** Separated stems, which is the whole of what the vocal-exit gesture needs. */
    stems: boolean;
    /** Both: the desktop build, with its weights present and working. */
    full: boolean;
}

export const transitionCapabilities = (): TransitionCapabilities => {
    const beatGrid = canRunBeatThis();
    const stems = canSeparateStems();
    return { beatGrid, stems, full: beatGrid && stems };
};
