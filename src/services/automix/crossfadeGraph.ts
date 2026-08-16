import { equalPowerGains } from './transitionPlanner';

// src/services/automix/crossfadeGraph.ts
// The Web Audio half of automix: two identical deck chains feeding one mix point, and the
// equal-power ramp that hands loudness from one to the other. No React, no DOM queries.

export interface AutomixDeckChain {
    source: MediaElementAudioSourceNode;
    /** Per-track loudness compensation. Set discretely; never automated by a blend. */
    replayGain: GainNode;
    /** The 0..1 crossfade envelope. The only node a blend automates. */
    fade: GainNode;
}

/**
 * Wires one deck into the shared mix point.
 *
 * ReplayGain sits on the deck rather than on the shared output because loudness compensation is
 * a per-track value: during a blend the two tracks need different ones. It stays a separate node
 * from the fade so that a discrete gain change can never scale the running crossfade curve.
 */
export const connectAutomixDeck = (
    context: AudioContext,
    element: HTMLAudioElement,
    output: AudioNode,
): AutomixDeckChain => {
    const source = context.createMediaElementSource(element);
    const replayGain = context.createGain();
    const fade = context.createGain();
    source.connect(replayGain).connect(fade).connect(output);
    return { source, replayGain, fade };
};

// setValueCurveAtTime interpolates linearly between points, so 64 of them across a blend keeps
// the error against the true cosine well under a tenth of a dB - inaudible, and one array each.
const CURVE_POINTS = 64;

const buildCurve = (side: 'out' | 'in') => {
    const curve = new Float32Array(CURVE_POINTS);
    for (let index = 0; index < CURVE_POINTS; index += 1) {
        curve[index] = equalPowerGains(index / (CURVE_POINTS - 1))[side];
    }
    return curve;
};

export const CROSSFADE_OUT_CURVE = buildCurve('out');
export const CROSSFADE_IN_CURVE = buildCurve('in');

/** Moves a gain to a value, instantly when seconds is 0 and over a short ramp otherwise. */
export const rampGain = (context: AudioContext, gain: GainNode, value: number, seconds = 0) => {
    const now = context.currentTime;
    gain.gain.cancelScheduledValues(now);
    if (seconds <= 0) {
        gain.gain.setValueAtTime(value, now);
        return;
    }
    gain.gain.setValueAtTime(gain.gain.value, now);
    gain.gain.linearRampToValueAtTime(value, now + seconds);
};

/**
 * Schedules both halves of one blend on the audio clock.
 *
 * Scheduled rather than driven from rAF on purpose: the ramp then runs at audio rate inside the
 * rendering thread, so a dropped frame or a busy main thread cannot dent the envelope.
 *
 * Returns false if the engine rejected the curves, having first put both decks back into a
 * defined state - a blend is optional, but audio that is stuck at zero gain is not recoverable.
 */
export const scheduleCrossfade = (
    context: AudioContext,
    outgoing: GainNode,
    incoming: GainNode,
    seconds: number,
): boolean => {
    const startAt = context.currentTime;
    try {
        outgoing.gain.cancelScheduledValues(startAt);
        incoming.gain.cancelScheduledValues(startAt);
        outgoing.gain.setValueCurveAtTime(CROSSFADE_OUT_CURVE, startAt, seconds);
        incoming.gain.setValueCurveAtTime(CROSSFADE_IN_CURVE, startAt, seconds);
        return true;
    } catch (error) {
        console.warn('[Automix] Crossfade rejected by the audio engine, cutting instead', error);
        rampGain(context, outgoing, 0, 0.05);
        rampGain(context, incoming, 1, 0.05);
        return false;
    }
};
