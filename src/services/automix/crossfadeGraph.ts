import { createDeckAnalyser, type DeckAnalyser } from './deckAnalyser';
import { buildCrossfadeCurves, dbToGain } from './signalAnalysis';

// src/services/automix/crossfadeGraph.ts
// The Web Audio half of automix: two identical deck chains feeding one mix point, and the ramp
// that hands loudness from one to the other. No React, no DOM queries.

export interface AutomixDeckChain {
    source: MediaElementAudioSourceNode;
    /** Per-track loudness compensation from the track's own metadata. Owned by the audio bridge. */
    replayGain: GainNode;
    /** Balance correction applied to the outgoing deck for the length of one blend. */
    trim: GainNode;
    /** The 0..1 crossfade envelope. The only node a scheduled blend automates. */
    fade: GainNode;
    /** Measures this deck ahead of the fade, so it reads the track and not the blend. */
    analyser: DeckAnalyser;
}

/**
 * Wires one deck into the shared mix point.
 *
 * Four nodes rather than one because three different authorities set gain here on different
 * timescales - the track's ReplayGain metadata, the blend's balance correction, and the crossfade
 * curve itself - and a running setValueCurveAtTime owns its parameter outright: anything else
 * writing to the same param during a blend throws, and folding them together would let a discrete
 * gain change scale the curve.
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
    source.connect(replayGain).connect(trim).connect(fade).connect(output);
    // Tapped off replayGain: the reading has to include the track's own loudness compensation and
    // exclude our trim, or the balance correction would be measuring its own effect.
    return {
        source,
        replayGain,
        trim,
        fade,
        analyser: createDeckAnalyser(context, replayGain, output),
    };
};

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

/** Same as rampGain, in the unit the balance correction is actually reasoning in. */
export const rampGainDb = (context: AudioContext, gain: GainNode, db: number, seconds: number) =>
    rampGain(context, gain, dbToGain(db), seconds);

/**
 * Schedules both halves of one blend on the audio clock.
 *
 * Scheduled rather than driven from rAF on purpose: the ramp then runs at audio rate inside the
 * rendering thread, so a dropped frame or a busy main thread cannot dent the envelope. The
 * crossover moves where the two tracks change places without touching that guarantee - the curves
 * are built before they are handed over, and nothing rewrites them once they are running.
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
): boolean => {
    const curves = buildCrossfadeCurves(crossover);
    const startAt = context.currentTime;
    try {
        outgoing.gain.cancelScheduledValues(startAt);
        incoming.gain.cancelScheduledValues(startAt);
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
