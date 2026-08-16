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
    /** Takes this deck's low end out of the way while the other one owns it. */
    lowCut: BiquadFilterNode;
    /** The 0..1 crossfade envelope. The only node a scheduled blend automates. */
    fade: GainNode;
    /** Measures this deck ahead of the fade, so it reads the track and not the blend. */
    analyser: DeckAnalyser;
}

/**
 * Where a deck's low end is pushed back to while the other track owns it.
 *
 * Two tracks playing at once sound muddy almost entirely below this point: bass carries most of
 * the energy, so overlapping it doubles the level, two bass lines in different keys beat against
 * each other, and near-coincident fundamentals cancel. The ear is unforgiving there and quite
 * tolerant of overlapping mids, which is why every DJ mixer has a bass kill and why swapping the
 * low end is worth more than any change to the gain curve.
 */
export const BASS_SWAP_HZ = 250;
/** Under every musical fundamental: the filter is in the chain but doing nothing. */
export const BASS_OPEN_HZ = 20;
/** Longest either side takes to hand the bass over. Short enough to read as one moment. */
const BASS_SWAP_RAMP_SEC = 0.7;

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
    const lowCut = context.createBiquadFilter();
    const fade = context.createGain();
    lowCut.type = 'highpass';
    lowCut.frequency.value = BASS_OPEN_HZ;
    // Butterworth rather than the Web Audio default of 1, which puts a resonant bump right on the
    // corner - audible as a honk sweeping through the mix every time the bass changes hands.
    lowCut.Q.value = Math.SQRT1_2;
    source.connect(replayGain).connect(trim).connect(lowCut).connect(fade).connect(output);
    // Tapped off replayGain: the reading has to include the track's own loudness compensation and
    // exclude our trim, or the balance correction would be measuring its own effect.
    return {
        source,
        replayGain,
        trim,
        lowCut,
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

/** Puts a deck's low end back where it belongs. Runs on every settle, like the trim does. */
export const resetLowCut = (context: AudioContext, filter: BiquadFilterNode, seconds = 0.05) => {
    const now = context.currentTime;
    filter.frequency.cancelScheduledValues(now);
    filter.frequency.setValueAtTime(Math.max(BASS_OPEN_HZ, filter.frequency.value), now);
    filter.frequency.exponentialRampToValueAtTime(BASS_OPEN_HZ, now + Math.max(0.01, seconds));
};

/**
 * Hands the low end from one deck to the other across the middle of a blend.
 *
 * The incoming track arrives with its bass already out of the way and only its mids and top
 * stacked on the outgoing one, then the two exchange: the listener hears a full mix throughout,
 * never two of them. Ramped exponentially because a filter corner is heard logarithmically - a
 * linear sweep spends most of its time in the last octave and reads as a swoop.
 */
export const scheduleBassSwap = (
    context: AudioContext,
    outgoing: BiquadFilterNode,
    incoming: BiquadFilterNode,
    startAt: number,
    seconds: number,
    crossover: number,
) => {
    const swapAt = startAt + seconds * crossover;
    // Kept inside the blend at both ends, so neither deck is still sweeping once it is alone.
    const half = Math.max(0.01, Math.min(
        BASS_SWAP_RAMP_SEC / 2,
        (seconds * crossover) / 2,
        (seconds * (1 - crossover)) / 2,
    ));

    ([[incoming, BASS_SWAP_HZ, BASS_OPEN_HZ], [outgoing, BASS_OPEN_HZ, BASS_SWAP_HZ]] as const)
        .forEach(([filter, from, to]) => {
            filter.frequency.cancelScheduledValues(startAt);
            filter.frequency.setValueAtTime(from, startAt);
            filter.frequency.setValueAtTime(from, swapAt - half);
            filter.frequency.exponentialRampToValueAtTime(to, swapAt + half);
        });
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
): boolean => {
    const curves = buildCrossfadeCurves(crossover);
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
