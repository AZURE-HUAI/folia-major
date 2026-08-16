import { rampGain, scheduleCrossfade, type AutomixDeckChain } from './crossfadeGraph';
import { planTransition, resolveOverlap, type TransitionPlan, type TransitionTrack } from './transitionPlanner';

// src/services/automix/automixSession.ts
// The automix state machine, with every browser and React dependency behind a port so the
// decisions can be exercised without a DOM or an audio device.
//
// idle -> armed    a blend was planned; the next track has been requested and the deck roles have
//                  already swapped, so the outgoing track keeps sounding on the deck it started on
// armed -> fading  the incoming deck actually made a sound, and the ramp is on the audio clock
// fading -> idle   the overlap elapsed
//
// Every arrow out of armed and fading also exists as a refusal: the transition can be dropped at
// any point up to the moment the ramp is scheduled, because a blend nobody can vouch for is worse
// than the plain cut it replaced.

export type AutomixDeckId = 'A' | 'B';
export type AutomixPhase = 'idle' | 'armed' | 'fading';

export const otherDeck = (deck: AutomixDeckId): AutomixDeckId => (deck === 'A' ? 'B' : 'A');

/** Long enough for the last scheduled curve point to be consumed before the deck is torn down. */
const FADE_CLEANUP_MARGIN_MS = 150;
/** A refused blend still has to get the outgoing deck to silence without a click. */
const CUT_SECONDS = 0.05;

export interface AutomixSessionPorts {
    getContext: () => AudioContext | null;
    getElement: (deck: AutomixDeckId) => HTMLAudioElement | null;
    getChain: (deck: AutomixDeckId) => AutomixDeckChain | null;
    /** Hands the deck role over: repoints the app's audio ref and rebinds the src of both decks. */
    onActiveDeckChange: (deck: AutomixDeckId) => void;
    /** Pins the outgoing source on the deck that is fading out; null once it is released. */
    onTailSrcChange: (src: string | null) => void;
    /** Runs the queue's ordinary advance, early. */
    advanceTrack: () => void;
}

export interface AutomixTransitionRequest {
    /** Seconds into the outgoing track. */
    time: number;
    /** The source the outgoing deck is playing; pinned to it across the swap. */
    audioSrc: string;
    from: TransitionTrack;
    to: TransitionTrack;
    /** Playback key of the track the queue will advance to, checked again before the ramp. */
    nextKey: string;
}

export const createAutomixSession = (ports: AutomixSessionPorts) => {
    let activeDeck: AutomixDeckId = 'A';
    let phase: AutomixPhase = 'idle';
    let plan: TransitionPlan | null = null;
    let plannedNextKey: string | null = null;
    let cleanupTimer: ReturnType<typeof setTimeout> | null = null;

    const clearCleanupTimer = () => {
        if (cleanupTimer === null) return;
        clearTimeout(cleanupTimer);
        cleanupTimer = null;
    };

    /** Returns both decks to a defined idle state. The one path every ending shares. */
    const settle = (options: { restoreActive: boolean; pauseTail: boolean }) => {
        clearCleanupTimer();
        const tailDeck = otherDeck(activeDeck);

        if (options.pauseTail) {
            ports.getElement(tailDeck)?.pause();
        }

        // Unity on both decks, always. A deck left at zero gain is silent playback: the one
        // failure here a listener cannot work around by pressing anything.
        const context = ports.getContext();
        if (context) {
            (['A', 'B'] as const).forEach(deck => {
                const chain = ports.getChain(deck);
                if (chain) rampGain(context, chain.fade, 1, 0.03);
            });
        }

        if (options.restoreActive) {
            activeDeck = tailDeck;
            ports.onActiveDeckChange(tailDeck);
        }

        phase = 'idle';
        plan = null;
        plannedNextKey = null;
        ports.onTailSrcChange(null);
    };

    /**
     * Plans the change and, only if the answer is a blend, starts the next track early.
     *
     * Doing nothing is the other half of the feature: for a clean cut we let the track end on its
     * own, so the queue advances exactly as it does today and the listener hears no difference.
     */
    const requestTransition = (request: AutomixTransitionRequest): TransitionPlan | null => {
        if (phase !== 'idle') return null;

        const nextPlan = planTransition(request.from, request.to);
        if (nextPlan.kind !== 'fade' || request.time < nextPlan.outStart) return nextPlan;

        const context = ports.getContext();
        const incoming = otherDeck(activeDeck);
        const incomingElement = ports.getElement(incoming);
        const incomingChain = ports.getChain(incoming);
        // Without both chains there is nothing to fade with, and swapping anyway would put two
        // tracks through the default output at full level - the worst outcome available here.
        if (!context || !incomingElement || !incomingChain || !ports.getChain(activeDeck)) {
            return nextPlan;
        }

        // Silence the incoming deck before it is allowed to make a sound, so the blend owns its
        // first sample instead of the track punching in at full level.
        rampGain(context, incomingChain.fade, 0);

        phase = 'armed';
        plan = nextPlan;
        plannedNextKey = request.nextKey;

        // The order matters: pin the outgoing source to the deck it is already playing on before
        // the roles change, so that deck's src string never changes and its playback is never
        // interrupted. Then advance, which is what eventually swaps in the new source.
        activeDeck = incoming;
        ports.onTailSrcChange(request.audioSrc);
        ports.onActiveDeckChange(incoming);

        ports.advanceTrack();
        return nextPlan;
    };

    /** The active deck started making sound. The last moment the blend can still be refused. */
    const handleActiveDeckPlaying = (currentKey: string | null) => {
        const context = ports.getContext();
        const activeChain = ports.getChain(activeDeck);

        if (phase !== 'armed') {
            // Whatever a cancelled blend left behind, a deck playing outside a transition sits at
            // unity. Cheap insurance against the only failure that is not self-correcting.
            if (context && activeChain) rampGain(context, activeChain.fade, 1, 0.02);
            return;
        }

        const tailDeck = otherDeck(activeDeck);
        const tailElement = ports.getElement(tailDeck);
        const tailChain = ports.getChain(tailDeck);

        if (!context || !plan || !activeChain || !tailChain || !tailElement) {
            settle({ restoreActive: false, pauseTail: true });
            return;
        }

        const overlap = resolveOverlap(plan, tailElement.duration - tailElement.currentTime);
        // The queue can move under us between planning and playing: a manual skip, or a track
        // that turned out to be unavailable and auto-skipped. Blending into a song we never
        // measured is precisely the bad transition this feature exists to refuse.
        const refusal = currentKey !== plannedNextKey
            ? 'the queue moved after planning'
            : overlap <= 0 ? 'the outgoing track ran out first' : null;

        phase = 'fading';

        if (refusal) {
            console.log(`[Automix] dropping blend, ${refusal}`);
            rampGain(context, tailChain.fade, 0, CUT_SECONDS);
            rampGain(context, activeChain.fade, 1, CUT_SECONDS);
        } else {
            scheduleCrossfade(context, tailChain.fade, activeChain.fade, overlap);
        }

        cleanupTimer = setTimeout(
            () => settle({ restoreActive: false, pauseTail: true }),
            refusal ? CUT_SECONDS * 1000 + 70 : overlap * 1000 + FADE_CLEANUP_MARGIN_MS,
        );
    };

    /** The non-active deck reached its end, or failed to load. */
    const handleTailEnded = () => {
        // Mid-blend this is just the outgoing track running out on schedule. Leave it to the
        // scheduled ramp, which still owns the incoming deck's fade-in; resetting gains here
        // would jump that fade to full a fraction early.
        if (phase === 'fading') return;

        // Still armed means the next track never arrived. Give the finished deck its role back so
        // the app's ordinary end-of-track path owns playback again: the advance already in flight
        // lands on it and the listener simply hears today's plain gap.
        settle({ restoreActive: phase === 'armed', pauseTail: false });
    };

    /**
     * Any pause, from the UI, a media key or the OS.
     *
     * Returns true when it interrupted an armed transition, which the caller has to act on: the
     * early advance is already in flight and cannot be recalled, so without suppressing its
     * autoplay the listener would press pause and hear the next song start anyway.
     */
    const abort = (): boolean => {
        if (phase === 'idle') return false;
        const wasArmed = phase === 'armed';
        settle({ restoreActive: wasArmed, pauseTail: true });
        return wasArmed;
    };

    return {
        getActiveDeck: () => activeDeck,
        getPhase: () => phase,
        requestTransition,
        handleActiveDeckPlaying,
        handleTailEnded,
        abort,
        dispose: clearCleanupTimer,
    };
};

export type AutomixSession = ReturnType<typeof createAutomixSession>;
