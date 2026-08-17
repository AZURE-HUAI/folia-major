import { createDeckAnalyser, type DeckAnalyser } from './deckAnalyser';
import {
    buildBandCurves,
    buildCrossfadeCurves,
    dbToGain,
    type BandBlendRequest,
    TONE_EDGE_HZ,
    TONE_MID_HZ,
} from './signalAnalysis';

// src/services/automix/crossfadeGraph.ts
// The Web Audio half of automix: two identical deck chains feeding one mix point, and the ramp
// that hands loudness from one to the other. No React, no DOM queries.

/** The three filters that give each region of the spectrum its own seam. All flat at rest. */
export interface AutomixToneStack {
    /** Low shelf at TONE_EDGE_HZ[0]. Owns the region an overlap goes muddy in. */
    low: BiquadFilterNode;
    /** Bell over the middle. Where both tracks stay recognisable; touched only by the tone match. */
    mid: BiquadFilterNode;
    /** High shelf at TONE_EDGE_HZ[1]. The outgoing track loses this on its way out. */
    high: BiquadFilterNode;
}

/** A short delay the outgoing track can be thrown into so a cut scatters instead of stopping. */
export interface AutomixThrow {
    send: GainNode;
    delay: DelayNode;
    feedback: GainNode;
}

export interface AutomixDeckChain {
    source: MediaElementAudioSourceNode;
    /** Per-track loudness compensation from the track's own metadata. Owned by the audio bridge. */
    replayGain: GainNode;
    /** Balance correction applied to the outgoing deck for the length of one blend. */
    trim: GainNode;
    /** Per-band shaping, so a handover is not one gain curve for the whole spectrum. */
    tone: AutomixToneStack;
    /** The 0..1 crossfade envelope. The only node a scheduled blend automates end to end. */
    fade: GainNode;
    /** The echo throw. Silent unless a transition asks for it. */
    throw: AutomixThrow;
    /** Measures this deck ahead of the fade, so it reads the track and not the blend. */
    analyser: DeckAnalyser;
}

/**
 * Bell width for the middle band.
 *
 * Wide - a Q under one spans well over two octaves - because this is not an equaliser correcting a
 * resonance, it is a tone control asked to lean a whole master slightly one way. A narrow bell
 * would be audible as a filter rather than as a difference in character.
 */
const MID_BELL_Q = 0.8;

/** Longest a scheduled band curve is allowed to still be running once its deck is alone. */
const TONE_RESET_SEC = 0.12;

/**
 * How long the thrown echo takes to repeat, when there is no tempo to derive it from.
 *
 * An eighth note at 120, which is the tempo nothing in a library is far from. With a tempo it is
 * derived instead, because an echo that repeats off the grid is heard as a fault rather than as an
 * effect.
 */
const DEFAULT_THROW_DELAY_SEC = 0.25;
/** How much of each repeat survives into the next. Four or five audible repeats, then gone. */
const THROW_FEEDBACK = 0.45;
/** How much of the outgoing track is fed in at the moment of the throw. */
const THROW_SEND = 0.6;
/** How long the send takes to open. Long enough not to click, short enough to be one gesture. */
const THROW_OPEN_SEC = 0.15;

/**
 * Wires one deck into the shared mix point.
 *
 * Gain is split across three nodes rather than one because three different authorities set it here
 * on different timescales - the track's ReplayGain metadata, the blend's balance correction, and
 * the crossfade curve itself - and a running setValueCurveAtTime owns its parameter outright:
 * anything else writing to the same param during a blend throws, and folding them together would
 * let a discrete gain change scale the curve.
 *
 * The three tone filters sit between the trim and the fade, and are exactly transparent at rest:
 * a shelf or a bell at 0dB is not an approximation of unity, its coefficients reduce to it. That
 * matters because this chain carries every second of playback, not only the transitions.
 */
export const connectAutomixDeck = (
    context: AudioContext,
    element: HTMLAudioElement,
    output: AudioNode,
): AutomixDeckChain => {
    const source = context.createMediaElementSource(element);
    const replayGain = context.createGain();
    const trim = context.createGain();
    const fade = context.createGain();

    const band = (type: BiquadFilterType, frequency: number, q?: number) => {
        const filter = context.createBiquadFilter();
        filter.type = type;
        filter.frequency.value = frequency;
        filter.gain.value = 0;
        if (q !== undefined) filter.Q.value = q;
        return filter;
    };
    const tone: AutomixToneStack = {
        low: band('lowshelf', TONE_EDGE_HZ[0]),
        mid: band('peaking', TONE_MID_HZ, MID_BELL_Q),
        high: band('highshelf', TONE_EDGE_HZ[1]),
    };

    source.connect(replayGain).connect(trim)
        .connect(tone.low).connect(tone.mid).connect(tone.high)
        .connect(fade).connect(output);

    // Fed from BEFORE the fade on purpose. The whole point of a throw is that the outgoing track
    // scatters instead of stopping, so what is thrown has to survive the curve that is removing it.
    const send = context.createGain();
    send.gain.value = 0;
    const delay = context.createDelay(2);
    delay.delayTime.value = DEFAULT_THROW_DELAY_SEC;
    const feedback = context.createGain();
    feedback.gain.value = THROW_FEEDBACK;
    tone.high.connect(send).connect(delay).connect(output);
    delay.connect(feedback).connect(delay);

    // Tapped off replayGain: the reading has to include the track's own loudness compensation and
    // exclude our trim, or the balance correction would be measuring its own effect.
    return {
        source,
        replayGain,
        trim,
        tone,
        fade,
        throw: { send, delay, feedback },
        analyser: createDeckAnalyser(context, replayGain, output),
    };
};

/**
 * Clears a parameter's schedule, including a curve that is already running.
 *
 * `cancelScheduledValues` only removes events that have not STARTED. A setValueCurveAtTime that is
 * part way through survives it, and the next write inside that curve's span is a NotSupportedError -
 * which is thrown from settle, which is the one path every ending shares. `cancelAndHoldAtTime`
 * truncates the curve and holds its current value, which is exactly what a cancelled blend wants;
 * the fallback is only for engines that predate it.
 */
const releaseParam = (param: AudioParam, now: number) => {
    if (typeof param.cancelAndHoldAtTime === 'function') param.cancelAndHoldAtTime(now);
    else param.cancelScheduledValues(now);
};

/** Moves a gain to a value, instantly when seconds is 0 and over a short ramp otherwise. */
export const rampGain = (context: AudioContext, gain: GainNode, value: number, seconds = 0) => {
    const now = context.currentTime;
    releaseParam(gain.gain, now);
    if (seconds <= 0) {
        gain.gain.setValueAtTime(value, now);
        return;
    }
    gain.gain.setValueAtTime(gain.gain.value, now);
    gain.gain.linearRampToValueAtTime(value, now + seconds);
};

/** Same as rampGain, in the unit the balance correction is actually reasoning in. */
export const rampGainDb = (context: AudioContext, gain: GainNode, db: number, seconds: number) =>
    rampGain(context, gain, dbToGain(db), seconds);

/**
 * Puts a deck's tone back where it belongs. Runs on every settle, like the trim does.
 *
 * All three bands together, because a deck left with its low end twenty-four decibels down is a
 * deck that plays the next track with no bass in it - the same class of failure as a deck left at
 * zero gain, and just as impossible for a listener to work around.
 */
export const resetTone = (context: AudioContext, tone: AutomixToneStack, seconds = 0.05) => {
    const now = context.currentTime;
    const span = Math.max(0.01, seconds);
    ([tone.low, tone.mid, tone.high]).forEach(filter => {
        releaseParam(filter.gain, now);
        filter.gain.setValueAtTime(filter.gain.value, now);
        filter.gain.linearRampToValueAtTime(0, now + span);
    });
};

/** Shuts the throw off. The delay line's own feedback lets whatever is in it ring out. */
export const resetThrow = (context: AudioContext, send: AutomixThrow, seconds = 0.05) =>
    rampGain(context, send.send, 0, seconds);

/**
 * Gives each region of the spectrum its own seam across one blend.
 *
 * This is what replaced sweeping a high-pass across the incoming deck. The filter version could
 * only answer one question - who owns the bass - and answered it by removing a band outright. Three
 * curves answer three: who owns the bass, how the departing track is taken out of the way, and how
 * far the arriving one bends towards the departing one's character on the way in. All three run on
 * the audio clock as curves, so a busy main thread cannot dent them, and all three are relative to
 * the overall gain envelope rather than replacing it.
 */
export const scheduleBandBlend = (
    context: AudioContext,
    outgoing: AutomixToneStack,
    incoming: AutomixToneStack,
    startAt: number,
    seconds: number,
    request: BandBlendRequest,
): boolean => {
    const curves = buildBandCurves(request);
    const bands = (stack: AutomixToneStack) => [stack.low, stack.mid, stack.high];
    try {
        ([[bands(outgoing), curves.out], [bands(incoming), curves.in]] as const).forEach(
            ([filters, shapes]) => filters.forEach((filter, band) => {
                // No event AT startAt ahead of the curve: the engine refuses a curve that overlaps
                // any other automation, and that includes its own first instant. The curve's first
                // value lands there of its own accord.
                filter.gain.cancelScheduledValues(startAt);
                filter.gain.setValueCurveAtTime(shapes[band], startAt, seconds);
                // Explicitly back to flat straight after the curve. A setValueCurveAtTime leaves
                // the param at its last value forever, and "forever" here is the next track.
                filter.gain.setValueAtTime(shapes[band][shapes[band].length - 1], startAt + seconds);
                filter.gain.linearRampToValueAtTime(0, startAt + seconds + TONE_RESET_SEC);
            }),
        );
        return true;
    } catch (error) {
        // Band shaping is an improvement on a crossfade, not a precondition for one. Both stacks go
        // back to flat and the gain curve carries the transition on its own.
        console.warn('[Automix] band shaping rejected by the audio engine, blending flat', error);
        resetTone(context, outgoing, 0.05);
        resetTone(context, incoming, 0.05);
        return false;
    }
};

/**
 * Throws the outgoing track into a short delay just before it is taken away.
 *
 * The one thing that makes a cut sound like a decision rather than a fault. A track that simply
 * stops has an edge on it; a track thrown into a delay carries on scattering after it is gone, and
 * the incoming one arrives into that instead of into a hole. It is the single most recognisable
 * move a human DJ makes, and it needs no analysis of either track - only a beat length, so the
 * repeats land on the grid rather than across it.
 *
 * The send is opened, not the delay: the line is always connected and always silent, so nothing is
 * created or routed at the moment it is needed.
 */
export const scheduleEchoThrow = (
    context: AudioContext,
    node: AutomixThrow,
    /** When the track is taken away. The throw opens just before it. */
    at: number,
    /** Beat period of the outgoing track, for the repeat length. Null falls back to an eighth at 120. */
    periodSec: number | null,
): void => {
    const repeat = periodSec && periodSec > 0
        ? Math.min(1, Math.max(0.08, periodSec / 2))
        : DEFAULT_THROW_DELAY_SEC;
    const opensAt = Math.max(context.currentTime, at - THROW_OPEN_SEC);

    try {
        node.delay.delayTime.cancelScheduledValues(opensAt);
        node.delay.delayTime.setValueAtTime(repeat, opensAt);
        node.send.gain.cancelScheduledValues(opensAt);
        node.send.gain.setValueAtTime(0, opensAt);
        node.send.gain.linearRampToValueAtTime(THROW_SEND, Math.max(opensAt + 0.001, at));
        // Shut again the moment the track goes: what is already in the line keeps repeating, which
        // is the effect. Leaving the send open would feed it the silence of a paused deck instead.
        node.send.gain.setValueAtTime(THROW_SEND, Math.max(opensAt + 0.001, at));
        node.send.gain.linearRampToValueAtTime(0, Math.max(opensAt + 0.001, at) + 0.03);
    } catch (error) {
        console.warn('[Automix] the echo throw was refused, cutting dry instead', error);
        node.send.gain.value = 0;
    }
};

/**
 * Schedules both halves of one blend on the audio clock.
 *
 * Scheduled rather than driven from rAF on purpose: the ramp then runs at audio rate inside the
 * rendering thread, so a dropped frame or a busy main thread cannot dent the envelope. The
 * crossover moves where the two tracks change places without touching that guarantee - the curves
 * are built before they are handed over, and nothing rewrites them once they are running.
 *
 * `hold` is how long the incoming deck stays silent first. It is what makes a cut a cut: the
 * incoming deck cannot be told when to start - it starts when the media element manages to - so
 * placing a handover anywhere other than "right now" means letting it run muted until the moment
 * arrives. Zero for an ordinary crossfade.
 *
 * Returns false if the engine rejected the curves, having first put both decks back into a
 * defined state - a blend is optional, but audio stuck at zero gain is not recoverable.
 */
export const scheduleCrossfade = (
    context: AudioContext,
    outgoing: GainNode,
    incoming: GainNode,
    seconds: number,
    crossover = 0.5,
    hold = 0,
    /** Fraction of the blend both tracks stay held at level. 0 is a plain crossfade. */
    together = 0,
): boolean => {
    const curves = buildCrossfadeCurves(crossover, together);
    const now = context.currentTime;
    const startAt = now + Math.max(0, hold);
    try {
        outgoing.gain.cancelScheduledValues(now);
        incoming.gain.cancelScheduledValues(now);
        if (hold > 0) {
            outgoing.gain.setValueAtTime(1, now);
            incoming.gain.setValueAtTime(0, now);
        }
        outgoing.gain.setValueCurveAtTime(curves.out, startAt, seconds);
        incoming.gain.setValueCurveAtTime(curves.in, startAt, seconds);
        return true;
    } catch (error) {
        console.warn('[Automix] Crossfade rejected by the audio engine, cutting instead', error);
        rampGain(context, outgoing, 0, 0.05);
        rampGain(context, incoming, 1, 0.05);
        return false;
    }
};
