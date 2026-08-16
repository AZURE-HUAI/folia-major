import {
    rampGain,
    rampGainDb,
    resetLowCut,
    scheduleBassSwap,
    scheduleCrossfade,
    type AutomixDeckChain,
} from './crossfadeGraph';
import { planBlendShape, trimForBalance } from './signalAnalysis';
import { shapeBlend } from './transitionChooser';
import {
    AUTOMIX_MIN_OVERLAP_SEC,
    planTransition,
    resolveOverlap,
    type TransitionPlan,
    type TransitionTrack,
} from './transitionPlanner';

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
/** How often the balance correction re-reads the two decks during a blend. */
const BALANCE_INTERVAL_MS = 100;
/** Slow enough that the correction is never heard arriving. */
const BALANCE_RAMP_SEC = 0.4;
/** Nothing smaller than this is worth moving a gain for. */
const BALANCE_STEP_DB = 0.75;

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
    /** The two tracks are neighbours on one album, which is what allows a gapless join. */
    sameAlbum?: boolean;
    /** Playback key of the track the queue will advance to, checked again before the ramp. */
    nextKey: string;
}

export const createAutomixSession = (ports: AutomixSessionPorts) => {
    let activeDeck: AutomixDeckId = 'A';
    let phase: AutomixPhase = 'idle';
    let plan: TransitionPlan | null = null;
    let plannedNextKey: string | null = null;
    /** Leading silence on the track being blended into: the only wait that costs nothing. */
    let plannedIncomingLeadIn: number | null = null;
    let cleanupTimer: ReturnType<typeof setTimeout> | null = null;
    let balanceTimer: ReturnType<typeof setInterval> | null = null;
    let appliedTrimDb = 0;

    const clearTimers = () => {
        if (cleanupTimer !== null) {
            clearTimeout(cleanupTimer);
            cleanupTimer = null;
        }
        if (balanceTimer !== null) {
            clearInterval(balanceTimer);
            balanceTimer = null;
        }
    };

    /**
     * Keeps the outgoing track from sitting on top of the incoming one for the length of a blend.
     *
     * The curves hand over equal *power*, which only means equal *loudness* if the two masters
     * were cut at the same level - and across a real library they differ by up to 10dB, which is
     * exactly what "the old song drowns the new one" sounds like. Both decks are measured ahead of
     * their fade, so the comparison is master against master whatever the curves are doing.
     *
     * The correction only ever attenuates, only ever the track that is leaving, and never backs
     * off once applied: a monotonic one-way trim cannot oscillate, and over-trimming a track that
     * is halfway out of the door costs nothing.
     */
    const startBalanceCorrection = (
        context: AudioContext,
        tailChain: AutomixDeckChain,
        activeChain: AutomixDeckChain,
    ) => {
        appliedTrimDb = 0;
        balanceTimer = setInterval(() => {
            const outgoingDb = tailChain.analyser.loudnessDb();
            const incomingDb = activeChain.analyser.loudnessDb();
            if (outgoingDb === null || incomingDb === null) return;

            const target = trimForBalance(outgoingDb, incomingDb);
            if (target < appliedTrimDb + BALANCE_STEP_DB) return;

            appliedTrimDb = target;
            rampGainDb(context, tailChain.trim, -appliedTrimDb, BALANCE_RAMP_SEC);
        }, BALANCE_INTERVAL_MS);
    };

    /**
     * Returns both decks to a defined idle state. The one path every ending shares.
     *
     * Deliberately never hands the deck role back, however the transition ended. The role decides
     * which element React renders `audioSrc` onto, and by the time anything can go wrong the
     * advance is already in flight: moving the role would drop the next track's source onto a
     * different element than the one the audio bridge already called play() on, and the bridge
     * only reacts to the *source* changing - which it did not. Nothing would ever press play
     * again, and the listener hears the song end and then silence.
     */
    const settle = (options: { pauseTail: boolean }) => {
        clearTimers();
        const tailDeck = otherDeck(activeDeck);

        if (appliedTrimDb > 0) {
            console.log(`[Automix] held the outgoing track ${appliedTrimDb.toFixed(1)}dB down to keep it off the next one`);
            appliedTrimDb = 0;
        }

        if (options.pauseTail) {
            ports.getElement(tailDeck)?.pause();
        }

        // Unity on both decks, always. A deck left at zero gain is silent playback: the one
        // failure here a listener cannot work around by pressing anything. The trim and the low
        // cut go with it, or a deck that was faded out would come back attenuated and thin the
        // next time it is used.
        const context = ports.getContext();
        if (context) {
            (['A', 'B'] as const).forEach(deck => {
                const chain = ports.getChain(deck);
                if (!chain) return;
                rampGain(context, chain.fade, 1, 0.03);
                rampGain(context, chain.trim, 1, 0.03);
                resetLowCut(context, chain.lowCut);
            });
        }

        phase = 'idle';
        plan = null;
        plannedNextKey = null;
        plannedIncomingLeadIn = null;
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

        // The deck still playing is the one whose tempo sets the length: at this point it is the
        // active one, and the only track with any audio behind it to measure.
        const outgoingTempo = ports.getChain(activeDeck)?.analyser.tempo() ?? null;
        const nextPlan = planTransition(
            request.from,
            request.to,
            // The offline profile measured the whole file; the live tap only heard the last few
            // seconds. Prefer the profile, fall back to the tap for anything never analysed.
            request.from.profile?.bpm ?? outgoingTempo?.bpm ?? null,
            { sameAlbum: request.sameAlbum },
        );
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
        plannedIncomingLeadIn = request.to.profile?.leadIn ?? null;

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

        // A deck that just started is playing something new; its old measurements describe a
        // track nobody is listening to any more.
        activeChain?.analyser.reset();

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
            settle({ pauseTail: true });
            return;
        }

        const remaining = tailElement.duration - tailElement.currentTime;
        const overlap = resolveOverlap(plan, remaining);
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
            cleanupTimer = setTimeout(
                () => settle({ pauseTail: true }),
                CUT_SECONDS * 1000 + 70,
            );
            return;
        }

        // Everything measured about the outgoing track, spent here: its level decides how fast the
        // two swap places, and its beat grid decides where that swap lands.
        const tempo = tailChain.analyser.tempo();
        const outgoingDb = tailChain.analyser.loudnessDb();
        const nextBeatIn = tailChain.analyser.nextBeatIn(context.currentTime);
        const fade = planBlendShape({
            overlap,
            outgoingDb,
            nextBeatIn,
            periodSec: tempo?.periodSec ?? null,
            minOverlap: plan.minOverlap,
            maxOverlap: remaining,
        });
        const shape = shapeBlend({
            style: plan.style,
            room: overlap,
            overlap: fade.overlap,
            crossover: fade.crossover,
            nextBeatIn,
            periodSec: tempo?.periodSec ?? null,
            incomingLeadIn: plannedIncomingLeadIn,
        });

        const spans = shape.hold + shape.overlap;
        console.log(
            `[Automix] ${shape.style}${shape.style === plan.style ? '' : ` (planned ${plan.style})`}:`
            + `${shape.hold > 0.01 ? ` waits ${shape.hold.toFixed(2)}s, then` : ''}`
            + ` ${shape.overlap < 0.1 ? `${Math.round(shape.overlap * 1000)}ms` : `${shape.overlap.toFixed(2)}s`}`
            + ` at ${Math.round(shape.crossover * 100)}%`
            + `${shape.bassSwap ? ', low end swapped' : ''}`
            + `${fade.snappedToBeat && shape.style === plan.style ? ` on a beat (${tempo ? Math.round(tempo.bpm) : '?'} BPM)` : ''}`
            + `${outgoingDb === null ? '' : `, outgoing ${outgoingDb.toFixed(1)} dBFS`}`,
        );

        // Read before scheduling so the filter sweep and the gain curve share one start time.
        const startAt = context.currentTime + shape.hold;
        if (shape.bassSwap) {
            scheduleBassSwap(
                context, tailChain.lowCut, activeChain.lowCut, startAt, shape.overlap, shape.crossover,
            );
        }
        scheduleCrossfade(
            context, tailChain.fade, activeChain.fade, shape.overlap, shape.crossover, shape.hold,
        );
        // Only where there is an overlap to balance. Across a splice or a cut the two tracks are
        // never both audible, so pulling one down would just be a level step nobody asked for.
        if (shape.overlap >= AUTOMIX_MIN_OVERLAP_SEC) {
            startBalanceCorrection(context, tailChain, activeChain);
        }

        cleanupTimer = setTimeout(
            () => settle({ pauseTail: true }),
            spans * 1000 + FADE_CLEANUP_MARGIN_MS,
        );
    };

    /** The non-active deck reached its end, or failed to load. */
    const handleTailEnded = () => {
        // Mid-blend this is just the outgoing track running out on schedule. Leave it to the
        // scheduled ramp, which still owns the incoming deck's fade-in; resetting gains here
        // would jump that fade to full a fraction early.
        if (phase === 'fading') return;

        // Still armed means the outgoing track ran out before the next one managed to make a
        // sound - a slow URL resolve, a cold buffer. There is no blend left to have, but the deck
        // that is loading the next track keeps the role: it is where audioSrc is already headed
        // and the only element anything is going to press play on.
        settle({ pauseTail: false });
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
        settle({ pauseTail: true });
        return wasArmed;
    };

    return {
        getActiveDeck: () => activeDeck,
        getPhase: () => phase,
        requestTransition,
        handleActiveDeckPlaying,
        handleTailEnded,
        abort,
        dispose: clearTimers,
    };
};

export type AutomixSession = ReturnType<typeof createAutomixSession>;
