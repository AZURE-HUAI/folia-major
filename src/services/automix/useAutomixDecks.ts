import { useCallback, useEffect, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import { PlayerState } from '../../types';
import type { LyricData, SongResult, StageLoopMode } from '../../types';
import type { AudioQualityPreference } from '../../types/onlineMusic';
import { getPlaybackSongKey } from '../../utils/appPlaybackGuards';
import { getPrefetchedData } from '../prefetchService';
import { getSongAlbumLabel } from '../onlineMusic/songMetadata';
import { getTrackProfile } from './profileService';
import { connectAutomixDeck, type AutomixDeckChain } from './crossfadeGraph';
import { createAutomixSession, type AutomixDeckId, type AutomixSession } from './automixSession';
import { AUTOMIX_MAX_OVERLAP_SEC } from './transitionPlanner';

// src/services/automix/useAutomixDecks.ts
// The React shell around the automix state machine: two audio elements, which one the app's
// audioRef currently names, and the source each one renders. All of the decision-making lives in
// automixSession; this file only gathers what the planner needs and owns the two pieces of state
// that have to drive a render.
//
// The decks are equal - neither is "the real one". A song change during a transition just moves
// which deck audioRef names, so playback is never handed between elements mid-stream. That
// handover is the thing a smaller "main deck plus a temporary transition deck" design cannot do
// without a sample-alignment click.

export type { AutomixDeckId };

/**
 * Whether a player state means "the listener stopped this", as opposed to the player merely
 * passing through a non-playing state.
 *
 * Deliberately not `!== PLAYING`: playSong drops the player to IDLE partway through every
 * ordinary track change, so treating that as a pause would cancel every blend a fraction of a
 * second after it armed - and the feature would look like it simply did not work.
 */
export const isPausedByListener = (state: PlayerState): boolean => state === PlayerState.PAUSED;

/**
 * How often both decks are measured.
 *
 * 25ms is the hop the onset detector works at, and it bounds how precisely a blend can be put on
 * a beat. A timer rather than requestAnimationFrame because this is a music player: rAF stops
 * being called the moment the window is hidden, which is most of the time it is being used.
 */
const ANALYSER_INTERVAL_MS = 25;

/**
 * How long a settled transition is given to actually be making a sound before it is treated as
 * stalled. Long enough for the audio bridge's own autoplay, which waits on the lyrics fetch.
 */
const STALL_GRACE_MS = 2_500;
/**
 * How long to keep watching after that, and how often.
 *
 * A single check was not enough. When the next track's URL is slow to resolve, the deck that is
 * about to hold it still has no source at all at the 2.5s mark - so the check found nothing to
 * start, gave up, and the app stayed silent for exactly the case the check existed for. It has to
 * keep looking until a source turns up.
 */
const STALL_RETRY_MS = 1_000;
const STALL_ATTEMPTS = 10;

/**
 * The track the queue would advance to, mirroring handleNextTrack's own index maths.
 *
 * Deliberately does not reproduce the FM-mode top-up: that fetch is asynchronous, and a track we
 * cannot name yet is a track we cannot measure, so automix simply stays out of the way.
 */
const resolveNextQueueSong = (
    queue: SongResult[],
    currentSong: SongResult,
    loopMode: StageLoopMode,
): SongResult | null => {
    if (queue.length < 2) return null;
    const currentKey = getPlaybackSongKey(currentSong);
    const index = queue.findIndex(song => getPlaybackSongKey(song) === currentKey);

    const next = index >= 0 && index < queue.length - 1
        ? queue[index + 1]
        : loopMode === 'all' ? queue[0] : null;

    // Wrapping onto ourselves is a repeat, not a transition.
    return next && getPlaybackSongKey(next) !== currentKey ? next : null;
};

type UseAutomixDecksParams = {
    audioRef: MutableRefObject<HTMLAudioElement | null>;
    audioContextRef: MutableRefObject<AudioContext | null>;
    audioSrc: string | null;
    currentSong: SongResult | null;
    /**
     * Playback key of the track the app has committed to, updated synchronously by playSong.
     *
     * Separate from `currentSong` on purpose. See handleActiveDeckPlaying: the state and the ref
     * disagree for exactly as long as it takes React to commit, and the deck can start playing
     * inside that window.
     */
    currentSongKeyRef: MutableRefObject<string | number | null>;
    lyrics: LyricData | null;
    duration: number;
    playQueue: SongResult[];
    loopMode: StageLoopMode;
    audioQuality: AudioQualityPreference;
    playerState: PlayerState;
    /** False when automix is switched off, or while another subsystem owns playback. */
    isEnabled: boolean;
    /** Runs the queue's normal advance, exactly as the end of a track would. */
    onAdvanceTrack: () => void;
};

export function useAutomixDecks({
    audioRef,
    audioContextRef,
    audioSrc,
    currentSong,
    currentSongKeyRef,
    lyrics,
    duration,
    playQueue,
    loopMode,
    audioQuality,
    playerState,
    isEnabled,
    onAdvanceTrack,
}: UseAutomixDecksParams) {
    const [activeDeck, setActiveDeck] = useState<AutomixDeckId>('A');
    const [tailSrc, setTailSrc] = useState<string | null>(null);

    const elementsRef = useRef<Record<AutomixDeckId, HTMLAudioElement | null>>({ A: null, B: null });
    const chainsRef = useRef<Partial<Record<AutomixDeckId, AutomixDeckChain>>>({});
    const advanceRef = useRef(onAdvanceTrack);
    advanceRef.current = onAdvanceTrack;
    // Set when a pause interrupts an armed transition, consumed by the audio bridge's autoplay.
    const suppressAutoplayRef = useRef(false);
    const playerStateRef = useRef(playerState);
    playerStateRef.current = playerState;

    /**
     * Last resort against a transition that ends in silence.
     *
     * The audio bridge starts playback off the *source* changing, and a transition changes which
     * element that source lands on. Any path that gets the two out of step leaves a deck holding
     * the next track with nothing left in flight to press play on it, and the listener just hears
     * the music stop. Checked once, well after the bridge has had its own chance, and never
     * against a pause the listener asked for.
     */
    const scheduleStallCheck = useCallback(() => {
        let attempts = 0;
        const check = () => {
            attempts += 1;
            // A pause the listener asked for is not a stall, and resuming it would be worse than
            // any silence this guards against.
            if (playerStateRef.current === PlayerState.PAUSED) return;

            const deck = sessionRef.current!.getActiveDeck();
            const element = elementsRef.current[deck];
            if (element?.src) {
                if (!element.paused) return;
                // currentTime tells the two failures apart, and they have different causes: zero
                // means nothing ever pressed play on this deck, non-zero means it DID play and
                // something paused it again. Without it this line just says "it was silent".
                // `phase` matters as much as the rest: this check is scheduled at settle, but by
                // the time it runs a NEW transition may have armed, and an armed incoming deck is
                // SUPPOSED to be loaded and silent. Starting that one early breaks a good blend.
                console.log(
                    '[Automix] the deck holding the next track was never started, starting it',
                    {
                        deck,
                        phase: sessionRef.current!.getPhase(),
                        at: element.currentTime,
                        readyState: element.readyState,
                        ended: element.ended,
                    },
                );
                void element.play().catch(() => { });
                return;
            }
            // No source yet: the next track is still resolving. Keep looking rather than
            // concluding there is nothing wrong.
            if (attempts < STALL_ATTEMPTS) window.setTimeout(check, STALL_RETRY_MS);
        };
        window.setTimeout(check, STALL_GRACE_MS);
    }, []);

    const sessionRef = useRef<AutomixSession | null>(null);
    if (!sessionRef.current) {
        sessionRef.current = createAutomixSession({
            getContext: () => audioContextRef.current,
            getElement: deck => elementsRef.current[deck],
            getChain: deck => chainsRef.current[deck] ?? null,
            onActiveDeckChange: deck => {
                audioRef.current = elementsRef.current[deck];
                setActiveDeck(deck);
            },
            onTailSrcChange: src => {
                setTailSrc(src);
                // Null is the last thing every settle does, whichever way the transition ended.
                if (src === null) scheduleStallCheck();
            },
            advanceTrack: () => advanceRef.current(),
        });
    }
    const session = sessionRef.current;

    const bindDeck = useCallback((deck: AutomixDeckId, element: HTMLAudioElement | null) => {
        // A deck swapping to a DIFFERENT element mid-session means React unmounted and remounted
        // it. The replacement starts empty, so whatever was playing is gone and the fresh element
        // sits at currentTime 0 with nothing left to press play on it. Should never happen.
        const previous = elementsRef.current[deck];
        if (previous && element && previous !== element) {
            console.warn(`[Automix] deck ${deck} was remounted while it held a source`);
        }
        elementsRef.current[deck] = element;
        if (deck === session.getActiveDeck()) {
            audioRef.current = element;
        }
    }, [audioRef, session]);

    const registerDeckA = useCallback((element: HTMLAudioElement | null) => bindDeck('A', element), [bindDeck]);
    const registerDeckB = useCallback((element: HTMLAudioElement | null) => bindDeck('B', element), [bindDeck]);

    /**
     * Which source each deck renders.
     *
     * The invariant that makes the swap seamless: the outgoing deck's src string does not change
     * when it stops being active, so React never touches its src attribute and its playback is
     * never interrupted. While armed, the active deck is deliberately left without a source -
     * audioSrc still names the track the other deck is finishing, and handing it over would
     * restart the very song we are fading out of.
     */
    const deckSrc = useCallback((deck: AutomixDeckId): string | undefined => {
        if (deck !== activeDeck) return tailSrc ?? undefined;
        return audioSrc && audioSrc !== tailSrc ? audioSrc : undefined;
    }, [activeDeck, audioSrc, tailSrc]);

    const isActiveDeck = useCallback(
        (element: HTMLAudioElement | null) => Boolean(element) && element === audioRef.current,
        [audioRef],
    );

    const getActiveChain = useCallback(
        () => chainsRef.current[session.getActiveDeck()] ?? null,
        [session],
    );

    // Called once from the audio bridge on the first play, so both decks share the mix point, the
    // equaliser and the analyser. One equaliser downstream of the mix keeps CPU flat and, more
    // importantly, stops the tone from stepping in the middle of a blend.
    const connectDecks = useCallback((context: AudioContext, output: AudioNode) => {
        (['A', 'B'] as const).forEach(deck => {
            const element = elementsRef.current[deck];
            if (!element || chainsRef.current[deck]) return;
            chainsRef.current[deck] = connectAutomixDeck(context, element, output);
        });
        return Boolean(chainsRef.current.A && chainsRef.current.B);
    }, []);

    /**
     * One console line per song, whichever way the decision went.
     *
     * A feature whose job is to refuse most song changes is otherwise indistinguishable from a
     * feature that is broken - which is exactly how the first build of this read.
     */
    const lastReportRef = useRef<string | null>(null);
    const report = useCallback((signature: string, message: string) => {
        if (lastReportRef.current === signature) return;
        lastReportRef.current = signature;
        console.log(`[Automix] ${message}`);
    }, []);

    /**
     * Runs on every timeupdate of the active deck.
     *
     * The plan is rebuilt here rather than memoised because the incoming track's lyrics arrive
     * asynchronously from the prefetcher: a plan cached at the start of a song would almost always
     * have been made blind. The early-out keeps that to a handful of evaluations in the closing
     * seconds of a track.
     */
    const checkTransitionPoint = useCallback((time: number) => {
        if (!currentSong || !audioSrc) return;
        if (!Number.isFinite(duration) || duration <= 0) return;
        if (duration - time > AUTOMIX_MAX_OVERLAP_SEC) return;

        if (!isEnabled) return report('disabled', 'off - the Blend icon at the end of the volume row switches it on');
        if (loopMode === 'one') return report('loop-one', 'single-track loop, nothing to blend into');

        const nextSong = resolveNextQueueSong(playQueue, currentSong, loopMode);
        if (!nextSong) return report(`${audioSrc}:queue-end`, 'nothing queued after this track');

        // Queue neighbours already, so one shared album name is the whole test for a segue.
        const album = getSongAlbumLabel(currentSong);
        const plan = session.requestTransition({
            time,
            audioSrc,
            from: { duration, lines: lyrics?.lines ?? null, profile: getTrackProfile(currentSong) },
            to: {
                duration: nextSong.durationMs / 1000,
                // Already in memory for online tracks: the queue prefetcher fetches the next few
                // songs' lyrics on every song change. Local files have no such cache, so they get
                // the planner's default-length blend instead of a vocal-placed one.
                lines: getPrefetchedData(nextSong, audioQuality)?.lyrics?.lines ?? null,
                profile: getTrackProfile(nextSong),
            },
            sameAlbum: Boolean(album) && album === getSongAlbumLabel(nextSong),
            nextKey: getPlaybackSongKey(nextSong),
        });
        if (!plan) return;

        if (session.getPhase() === 'armed') {
            report(`${audioSrc}:armed`, `blending ${plan.overlap}s - ${plan.reason}`);
        } else if (plan.kind !== 'fade') {
            report(`${audioSrc}:cut`, `plain cut - ${plan.reason}`);
        } else if (time >= plan.outStart) {
            report(`${audioSrc}:unwired`, `wanted a ${plan.overlap}s blend but the decks are not on the audio graph`);
        }
    }, [audioQuality, audioSrc, currentSong, duration, isEnabled, loopMode, lyrics, playQueue, report, session]);

    /**
     * Reads the ref rather than the `currentSong` prop, and that is the whole correctness of it.
     *
     * The session checks this key against the one it planned for, to catch a queue that moved
     * after planning - a manual skip, an auto-skip past an unavailable track. But `currentSong` is
     * React state: playSong commits to the next track and only later does React render it. The
     * incoming deck can fire `playing` inside that window - it does whenever the next track was
     * already buffered - and then the state still names the PREVIOUS song. The session reads that
     * as "the queue moved" and drops a blend nobody moved anything under.
     *
     * playSong sets the ref synchronously, at the moment it commits to the track, so the ref and
     * the deck can never disagree the way the state and the deck can.
     */
    const handleActiveDeckPlaying = useCallback(() => {
        const key = currentSongKeyRef.current;
        session.handleActiveDeckPlaying(typeof key === 'string' ? key : null);
    }, [currentSongKeyRef, session]);

    const handleTailEnded = useCallback(() => session.handleTailEnded(), [session]);

    /** True while a deck other than the active one may still be sounding. */
    const isTransitionAudible = useCallback(() => session.getPhase() !== 'idle', [session]);

    /**
     * For the paths that stop everything outright rather than pausing.
     *
     * Those clear the active deck only; without this the deck fading out in the background would
     * keep playing with no control left pointing at it.
     */
    const abortTransition = useCallback(() => { session.abort(); }, [session]);

    // Both decks are measured continuously while playing, not only once a blend is imminent: the
    // tempo estimate needs seconds of history behind it, and by the time a transition is planned
    // there is none left to gather. One timer for both decks, and only while there is sound.
    useEffect(() => {
        if (!isEnabled || playerState !== PlayerState.PLAYING) return;
        const timer = setInterval(() => {
            const context = audioContextRef.current;
            if (!context) return;
            const now = context.currentTime;
            (['A', 'B'] as const).forEach(deck => chainsRef.current[deck]?.analyser.tick(now));
        }, ANALYSER_INTERVAL_MS);
        return () => clearInterval(timer);
    }, [audioContextRef, isEnabled, playerState]);

    // Any pause, from the UI, a media key or the OS, ends a transition. Watching player state
    // rather than the element's pause event matters: while armed the active deck is the silent
    // one, so it never fires a pause event of its own.
    useEffect(() => {
        if (playerState === PlayerState.PLAYING) {
            // Resuming re-authorises the advance that is still on its way.
            suppressAutoplayRef.current = false;
            return;
        }
        if (!isPausedByListener(playerState)) return;
        if (session.abort()) {
            suppressAutoplayRef.current = true;
        }
    }, [playerState, session]);

    useEffect(() => () => session.dispose(), [session]);

    return {
        activeDeck,
        suppressAutoplayRef,
        registerDeckA,
        registerDeckB,
        deckSrc,
        isActiveDeck,
        connectDecks,
        getActiveChain,
        checkTransitionPoint,
        handleActiveDeckPlaying,
        handleTailEnded,
        isTransitionAudible,
        abortTransition,
    };
}
