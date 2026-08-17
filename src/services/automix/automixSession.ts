import {
    rampGain,
    rampGainDb,
    resetThrow,
    resetTone,
    scheduleBandBlend,
    scheduleCrossfade,
    scheduleEchoThrow,
    type AutomixDeckChain,
} from './crossfadeGraph';
import { createDeckClock, type DeckClock } from './deckClock';
import { barGrid, settledBpm, type Grid } from './musicalTime';
import { planBlendShape, trimForBalance, BEATS_PER_BAR } from './signalAnalysis';
import { applyTempoBend, resetTempoBend } from './tempoBend';
import { shapeBlend } from './transitionChooser';
import {
    AUTOMIX_MIN_OVERLAP_SEC,
    planTransition,
    resolveOverlap,
    type TransitionPlan,
    type TransitionTrack,
} from './transitionPlanner';
import type { TrackProfile } from './trackProfile';

// src/services/automix/automixSession.ts
// The automix state machine, with every browser and React dependency behind a port so the
// decisions can be exercised without a DOM or an audio device.
//
// idle -> armed    a blend was planned; the next track has been requested and the deck roles have
//                  already swapped, so the outgoing track keeps sounding on the deck it started on
// armed -> fading  the incoming deck actually made a sound, and the ramp is on the audio clock
// fading -> idle   the overlap elapsed
//
// Arming happens a few seconds BEFORE the blend is due, and the app's autoplay is held over that
// gap - see AUTOMIX_ARM_LEAD_SEC. Loading a track and starting it are two different events, and
// the whole length of a blend depends on not treating them as one.
//
// Every arrow out of armed and fading also exists as a refusal: the transition can be dropped at
// any point up to the moment the ramp is scheduled, because a blend nobody can vouch for is worse
// than the plain cut it replaced.

export type AutomixDeckId = 'A' | 'B';
export type AutomixPhase = 'idle' | 'armed' | 'fading';

const otherDeck = (deck: AutomixDeckId): AutomixDeckId => (deck === 'A' ? 'B' : 'A');

/**
 * How early a blend is set up, ahead of the moment it is due to start sounding.
 *
 * Arming does two things at once and only one of them is cheap. It starts the queue's advance -
 * which is what puts the next track's name, lyrics and progress bar on screen - and it is also
 * what used to begin loading the audio. Loading takes seconds; the handover does not.
 *
 * So the audio is loaded somewhere else entirely: the idle deck is handed the next track's source
 * seconds earlier, with nothing else moving (see `deckSrc` in useAutomixDecks). By the time this
 * lead starts, the bytes are already buffered and all that is left to pay for is `playSong`'s own
 * cache reads, a React commit and `play()`.
 *
 * Which is why this is a second rather than the three it started at: a three second lead meant
 * three seconds of the next track's name on screen against a progress bar stuck at 0:00 while the
 * previous track was still playing - and on a short blend the frozen window was longer than the
 * transition it was protecting.
 */
export const AUTOMIX_ARM_LEAD_SEC = 1;

/**
 * How early the hold is lifted, to pay for the round trip between letting go and hearing it.
 *
 * Lifting the hold does not start a deck: it re-renders, runs the audio bridge's autoplay effect,
 * calls play() and waits for the element to say `playing`. Measured across a run of real
 * transitions that round trip is a consistent 100-150ms, and all of it used to come off the front
 * of the blend. Letting go a little early instead costs the outgoing track the same amount off its
 * very end - underneath a fade that has already finished, so nothing is lost.
 */
const RELEASE_MARGIN_SEC = 0.25;

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
/**
 * Longest the incoming deck may be held silent to land the handover where it was planned.
 *
 * The hold is what turns "the deck started when it managed to" into "the blend starts where the
 * plan said", and the gap it is closing is the release round trip - a tenth of a second or two.
 * Capped because everything waited is taken off the outgoing track's remaining tail, so a hold that
 * grew unbounded would shorten the blend it exists to place.
 */
const MAX_ALIGN_HOLD_SEC = 1;

export interface AutomixSessionPorts {
    getContext: () => AudioContext | null;
    getElement: (deck: AutomixDeckId) => HTMLAudioElement | null;
    getChain: (deck: AutomixDeckId) => AutomixDeckChain | null;
    /** Hands the deck role over: repoints the app's audio ref and rebinds the src of both decks. */
    onActiveDeckChange: (deck: AutomixDeckId) => void;
    /** Pins the outgoing source on the deck that is fading out; null once it is released. */
    onTailSrcChange: (src: string | null) => void;
    /**
     * Holds the app's autoplay while the incoming deck loads, until the blend is actually due.
     *
     * The deck still takes its source and buffers it - only pressing play is deferred. Released
     * from exactly one place, `setAutoplayHold`, so no path can leave the app silently held.
     */
    onAutoplayHoldChange: (held: boolean) => void;
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
    const clocks: Record<AutomixDeckId, DeckClock> = { A: createDeckClock(), B: createDeckClock() };
    let activeDeck: AutomixDeckId = 'A';
    let phase: AutomixPhase = 'idle';
    let plan: TransitionPlan | null = null;
    let plannedNextKey: string | null = null;
    /** Both offline profiles, kept from planning until the blend is actually scheduled. */
    let plannedFrom: TrackProfile | null = null;
    let plannedTo: TrackProfile | null = null;
    let cleanupTimer: ReturnType<typeof setTimeout> | null = null;
    let balanceTimer: ReturnType<typeof setInterval> | null = null;
    let releaseTimer: ReturnType<typeof setTimeout> | null = null;
    let holdingAutoplay = false;
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
        if (releaseTimer !== null) {
            clearTimeout(releaseTimer);
            releaseTimer = null;
        }
    };

    /** The only writer of the hold, so "held" and "the app is not playing" cannot come apart. */
    const setAutoplayHold = (held: boolean) => {
        if (holdingAutoplay === held) return;
        holdingAutoplay = held;
        ports.onAutoplayHoldChange(held);
    };

    /**
     * One reading of each deck's position against the audio clock.
     *
     * Called from the same timer that feeds the level analysers, so it costs a property read. What
     * it buys is the entire difference between "the incoming deck started at some point in a
     * hundred millisecond window" and "the outgoing track is at 187.4213 seconds right now" - see
     * deckClock. A paused or stalled deck is skipped rather than fitted, because a flat line
     * through a stopped clock is a rate of zero and would be believed.
     */
    const sampleDecks = (contextTime: number) => {
        (['A', 'B'] as const).forEach(deck => {
            const element = ports.getElement(deck);
            if (!element || element.paused || !Number.isFinite(element.currentTime)) return;
            clocks[deck].sample(element.currentTime, contextTime);
        });
    };

    /**
     * Seconds of WALL time from a media position to the next line of that track's own grid.
     *
     * Both halves of the conversion in one place: the grid is in the track's own seconds, the
     * answer is in the audio clock's, and a deck bent onto another tempo is running at neither one.
     */
    const waitToGrid = (grid: Grid | null, fromMedia: number, rate: number): number | null => {
        if (!grid || !(grid.period > 0) || !(rate > 0)) return null;
        const next = grid.offset + Math.ceil((fromMedia - grid.offset) / grid.period) * grid.period;
        return (next - fromMedia) / rate;
    };

    /**
     * Puts the incoming deck's playhead where the plan wants it to enter.
     *
     * Two reasons it is not zero, and they compose: the file's leading silence is not music, and
     * once past it the entry can be walked to whichever of the track's bar lines lands on one of
     * the outgoing track's. Applied twice - once on arming, once again just before the hold is
     * lifted - because everything else in the app that touches a fresh element also touches
     * currentTime, and the last write before play() is the one that counts.
     */
    const seekTo = (element: HTMLAudioElement, position: number) => {
        if (!(position > 0.05)) return;
        const apply = () => {
            if (Math.abs(element.currentTime - position) < 0.02) return;
            try {
                element.currentTime = position;
            } catch {
                // Not seekable yet. The second attempt before release usually is.
            }
        };
        if (element.readyState >= 1) apply();
        else element.addEventListener('loadedmetadata', apply, { once: true });
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
     *
     * `incomingReference` is what the incoming track settles at rather than what it is doing in
     * the second it starts, and that distinction is the whole correctness of this. A track's first
     * seconds are nearly always its intro, which is quiet *on purpose*; measuring it live and
     * calling the difference a mastering imbalance pulled the outgoing track down by the full
     * ceiling on essentially every song change, which is not a correction, it is a constant.
     */
    const startBalanceCorrection = (
        context: AudioContext,
        tailChain: AutomixDeckChain,
        activeChain: AutomixDeckChain,
        incomingReference: number | null,
    ) => {
        appliedTrimDb = 0;
        balanceTimer = setInterval(() => {
            const outgoingDb = tailChain.analyser.loudnessDb();
            const incomingDb = incomingReference ?? activeChain.analyser.loudnessDb();
            if (outgoingDb === null || incomingDb === null) return;

            const target = trimForBalance(outgoingDb, incomingDb);
            if (target < appliedTrimDb + BALANCE_STEP_DB) return;

            appliedTrimDb = target;
            rampGainDb(context, tailChain.trim, -appliedTrimDb, BALANCE_RAMP_SEC);
        }, BALANCE_INTERVAL_MS);
    };

    /**
     * The incoming track's own average level, in the units the taps report.
     *
     * The taps read *after* each deck's ReplayGain and the profile was measured *before* it, so the
     * deck's current compensation is added back on - otherwise with ReplayGain switched on the
     * comparison would credit the incoming track with an imbalance ReplayGain had already removed.
     * Null when the track was never analysed; then the live reading is all there is.
     */
    const incomingReferenceDb = (chain: AutomixDeckChain): number | null => (
        plannedTo === null
            ? null
            : plannedTo.loudness + 20 * Math.log10(Math.max(chain.replayGain.gain.value, 1e-6))
    );

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
        // Before anything else: a transition that ends while still holding the autoplay would
        // leave the app with a loaded deck nothing is ever going to press play on.
        setAutoplayHold(false);
        const tailDeck = otherDeck(activeDeck);

        if (appliedTrimDb > 0) {
            console.log(`[Automix] held the outgoing track ${appliedTrimDb.toFixed(1)}dB down to keep it off the next one`);
            appliedTrimDb = 0;
        }

        if (options.pauseTail) {
            ports.getElement(tailDeck)?.pause();
        }

        // Unity on both decks, always. A deck left at zero gain is silent playback: the one
        // failure here a listener cannot work around by pressing anything. The trim, the three
        // tone bands, the throw and the tempo go with it, or a deck that was faded out would come
        // back attenuated, thin, and running at the wrong speed the next time it is used.
        const context = ports.getContext();
        if (context) {
            (['A', 'B'] as const).forEach(deck => {
                const chain = ports.getChain(deck);
                if (!chain) return;
                rampGain(context, chain.fade, 1, 0.03);
                rampGain(context, chain.trim, 1, 0.03);
                resetTone(context, chain.tone);
                resetThrow(context, chain.throw);
                resetTempoBend(ports.getElement(deck));
            });
        }
        // The tail deck is about to be paused or handed a different track; either way the line
        // fitted to its position describes a track nobody is listening to any more.
        clocks[tailDeck].reset();

        phase = 'idle';
        plan = null;
        plannedNextKey = null;
        plannedFrom = null;
        plannedTo = null;
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
        );
        // Early by the lead, not on the dot: everything between here and `outStart` is what the
        // next track gets to load in, instead of taking it out of the blend.
        if (nextPlan.kind !== 'fade' || request.time < nextPlan.outStart - AUTOMIX_ARM_LEAD_SEC) {
            return nextPlan;
        }

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
        seekTo(incomingElement, nextPlan.inStart);
        // Its old readings describe wherever this deck was left after the last transition.
        clocks[incoming].reset();

        phase = 'armed';
        plan = nextPlan;
        plannedNextKey = request.nextKey;
        plannedFrom = request.from.profile ?? null;
        plannedTo = request.to.profile ?? null;

        // The order matters: pin the outgoing source to the deck it is already playing on before
        // the roles change, so that deck's src string never changes and its playback is never
        // interrupted. Then advance, which is what eventually swaps in the new source.
        activeDeck = incoming;
        ports.onTailSrcChange(request.audioSrc);
        ports.onActiveDeckChange(incoming);

        // Off the media clock rather than a stopwatch started later: this is how much of the
        // outgoing track is left over once the blend has had its share, which is exactly how long
        // the incoming deck may load for. Set before the advance, because the advance is what
        // eventually reaches the autoplay this is holding back.
        //
        // Read off the plan rather than re-derived from the duration. The two agreed for as long as
        // a blend ended where the file did; now that it ends where the MUSIC does, re-deriving it
        // here would release the hold a track's worth of trailing silence too late and the fade
        // would be clipped by exactly the amount the plan just moved.
        const startIn = nextPlan.outStart - request.time;
        if (startIn > RELEASE_MARGIN_SEC) {
            setAutoplayHold(true);
            releaseTimer = setTimeout(
                () => {
                    // Last write before play(): whatever else touched this element during the
                    // advance, the entry point is what it starts from.
                    seekTo(incomingElement, nextPlan.inStart);
                    setAutoplayHold(false);
                },
                (startIn - RELEASE_MARGIN_SEC) * 1000,
            );
        }

        ports.advanceTrack();
        return nextPlan;
    };

    /** The active deck started making sound. The last moment the blend can still be refused. */
    const handleActiveDeckPlaying = (currentKey: string | null) => {
        // Whatever started this deck - the released hold, the stall check, the listener - it is
        // making a sound now, so there is nothing left to hold back.
        setAutoplayHold(false);

        const context = ports.getContext();
        const activeChain = ports.getChain(activeDeck);

        // A deck that just started is playing something new; its old measurements describe a
        // track nobody is listening to any more.
        activeChain?.analyser.reset();
        clocks[activeDeck].reset();

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

        // How much of the outgoing track is still worth using, which stops where the music does -
        // `outStart + overlap` is the plan's own answer to that. Taking the element's duration
        // instead would offer the beat snap a track's trailing silence to move the handover into,
        // which is the one place it must never land. Clamped by the element as well: the profile
        // and the media are two independent measurements of the same file and can disagree.
        const soundingLeft = Math.min(tailElement.duration, plan.outStart + plan.overlap);

        // Where the outgoing track really is, to a fraction of a millisecond, rather than to the
        // tens of milliseconds `currentTime` reports. Everything below is placed against this.
        const now = context.currentTime;
        const tailClock = clocks[tailDeck];
        const position = tailClock.positionAt(now) ?? tailElement.currentTime;
        const tailRate = tailClock.rate() ?? 1;

        // The handover starts where the plan put it, not where the incoming deck happened to make
        // its first sound. The two differ by the release round trip - a tenth of a second or two -
        // and closing that gap is what makes a bar line a bar line rather than a near miss. Never
        // backwards: if the deck was late, the blend starts now and is shorter, as it always was.
        // Clamped here rather than after the fact: everything below measures the blend from this
        // moment, so a wait that was trimmed later would leave the length describing a start the
        // transition never had.
        const startMedia = Math.min(
            Math.max(position, Math.min(plan.outStart, soundingLeft)),
            position + MAX_ALIGN_HOLD_SEC,
        );
        const remaining = soundingLeft - startMedia;
        const overlap = resolveOverlap(plan, remaining);
        // The queue can move under us between planning and playing: a manual skip, or a track
        // that turned out to be unavailable and auto-skipped. Blending into a song we never
        // measured is precisely the bad transition this feature exists to refuse.
        const refusal = currentKey !== plannedNextKey
            ? 'the queue moved after planning'
            : overlap <= 0 ? 'the outgoing track ran out first' : null;

        phase = 'fading';

        // The one measurement that says whether AUTOMIX_ARM_LEAD_SEC is long enough. A blend
        // shorter than planned means the incoming deck spent the whole lead loading and then some,
        // so the remainder came out of the fade - the failure this lead exists to remove.
        if (overlap > 0 && overlap < plan.overlap - 0.05) {
            console.log(
                `[Automix] blend clipped to ${overlap}s of the planned ${plan.overlap}s:`
                + ` the next deck took more than its ${AUTOMIX_ARM_LEAD_SEC}s of lead to start`,
            );
        }

        if (refusal) {
            // Both keys, always: "the queue moved" is a claim about two strings, and when it is
            // wrong it is wrong silently - a perfectly good blend becomes a hard cut and the log
            // reads exactly the same as a real skip.
            console.log(
                `[Automix] dropping blend, ${refusal}`
                + (currentKey === plannedNextKey ? '' : ` (deck has "${currentKey}", planned "${plannedNextKey}")`),
            );
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
        // The tail's own tempo where the track's two readings of it agree - a track that slows into
        // its last chorus has two tempos, and one whose readings are a third apart has none. Null
        // falls through to the live tap, which is the only thing that actually heard the tail.
        const outgoingBpm = settledBpm(plannedFrom?.bpm, plannedFrom?.outroBpm);
        const periodSec = outgoingBpm ? 60 / outgoingBpm : tempo?.periodSec ?? null;

        // The rate is set before the wait is measured, because the wait is spent AT that rate.
        const stretch = plan.style === 'beatCut' || overlap < AUTOMIX_MIN_OVERLAP_SEC
            ? 1
            : plan.stretch;
        const applied = applyTempoBend(tailElement, stretch);
        const alignHold = Math.max(0, (startMedia - position) / (tailRate * applied));

        // Where the beats are, from the file rather than from the last few seconds of it.
        //
        // This used to be a live autocorrelation, because nothing else could answer it: the offline
        // profile knows where the beats sit in the FILE, and until the deck clock there was no way
        // to say where the file was on the audio clock. There is now, so the grid is arithmetic
        // rather than an estimate - measured forward from where the blend will START, not from
        // where the deck happens to be while this runs.
        //
        // Only when one tempo describes the whole track, though. `beatOffset` is a phase in the
        // whole-track grid; pairing it with a DIFFERENT period measured over the last half minute
        // gives a grid that is right about spacing and wrong about position, which is the worse of
        // the two errors. Where a track slowed down, the tap is the only thing that heard it.
        const steady = plannedFrom?.bpm
            && (plannedFrom.outroBpm === null || Math.abs((plannedFrom.outroBpm ?? 0) - plannedFrom.bpm) < 0.5);
        const beatGrid = steady && plannedFrom?.bpm
            ? { offset: plannedFrom.beatOffset % (60 / plannedFrom.bpm), period: 60 / plannedFrom.bpm }
            : null;
        const nextBeatIn = waitToGrid(beatGrid, startMedia, tailRate * applied)
            ?? tailChain.analyser.nextBeatIn(now + alignHold);
        const fade = planBlendShape({
            overlap,
            outgoingDb,
            nextBeatIn,
            periodSec,
            minOverlap: plan.minOverlap,
            maxOverlap: remaining,
        });
        const shape = shapeBlend({
            style: plan.style,
            room: overlap,
            overlap: fade.overlap,
            crossover: fade.crossover,
            nextBeatIn,
            periodSec,
            incomingLeadIn: plannedTo?.leadIn ?? null,
        });

        // Everything above is in the outgoing track's own seconds. Everything below is on the audio
        // clock, and the two stop being the same unit the moment that track is bent to meet the
        // incoming tempo: eight of its seconds at 1.1x take seven and a bit to play. One division,
        // in one place, is the whole of the conversion.
        const hold = alignHold + shape.hold;
        const startAt = now + hold;
        const wall = shape.overlap / applied;

        console.log(
            `[Automix] ${shape.style}${shape.style === plan.style ? '' : ` (planned ${plan.style})`}:`
            + `${hold > 0.01 ? ` waits ${hold.toFixed(2)}s, then` : ''}`
            + ` ${wall < 0.1 ? `${Math.round(wall * 1000)}ms` : `${wall.toFixed(2)}s`}`
            + ` at ${Math.round(shape.crossover * 100)}%`
            + `${shape.shapeBands ? ', three bands' : ''}`
            + `${shape.sweepOut ? ', swept out' : ''}`
            + `${plan.echoThrow ? ', thrown' : ''}`
            + `${applied === 1 ? '' : `, outgoing at ${applied.toFixed(3)}x`}`
            + `${fade.snappedToBeat && shape.style === plan.style ? ` on a beat (${periodSec ? Math.round(60 / periodSec) : '?'} BPM)` : ''}`
            + `${outgoingDb === null ? '' : `, outgoing ${outgoingDb.toFixed(1)} LUFS`}`
            + `${tailClock.fit() === null ? ', position estimated' : ''}`,
        );

        if (shape.shapeBands) {
            scheduleBandBlend(context, tailChain.tone, activeChain.tone, startAt, wall, {
                crossover: shape.crossover,
                swapBass: true,
                sweepOut: shape.sweepOut,
                tiltDb: plan.tiltDb,
            });
        }
        if (plan.echoThrow) {
            // A cut goes at the start of its own 40ms; an overlap goes where the two change places,
            // which is the moment the outgoing track stops being the one being listened to.
            scheduleEchoThrow(
                context,
                tailChain.throw,
                startAt + (shape.style === 'beatCut' ? 0 : wall * shape.crossover),
                periodSec,
            );
        }
        scheduleCrossfade(context, tailChain.fade, activeChain.fade, wall, shape.crossover, hold);
        // Only where there is an overlap to balance. Across a splice or a cut the two tracks are
        // never both audible, so pulling one down would just be a level step nobody asked for.
        if (shape.overlap >= AUTOMIX_MIN_OVERLAP_SEC) {
            startBalanceCorrection(context, tailChain, activeChain, incomingReferenceDb(activeChain));
        }

        cleanupTimer = setTimeout(
            () => settle({ pauseTail: true }),
            (hold + wall) * 1000 + FADE_CLEANUP_MARGIN_MS,
        );
    };

    /** The non-active deck reached its end, or failed to load. */
    const handleTailEnded = () => {
        // Outside a transition the non-active deck is not a tail at all - it is the idle deck,
        // holding the next track's source so it can buffer ahead. If that source fails to load
        // there is no transition to end, and settling one that was never started would pause a
        // deck and fire the stall check for nothing.
        if (phase === 'idle') return;

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
        sampleDecks,
        requestTransition,
        handleActiveDeckPlaying,
        handleTailEnded,
        abort,
        dispose: clearTimers,
    };
};

export type AutomixSession = ReturnType<typeof createAutomixSession>;
