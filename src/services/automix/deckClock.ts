// src/services/automix/deckClock.ts
// Where a deck actually is, on the audio clock, to well under a millisecond.
//
// This is the answer to a question that has been posed twice in this design as "we need to control
// when the incoming deck starts playing" - once as "pause it and release it at the right moment",
// once as "give up on media elements and schedule an AudioBufferSourceNode". Both are attempts to
// fix the ACTUATOR. The thing actually missing was the SENSOR.
//
// A crossfade is scheduled on the AudioContext clock, which is sample accurate; nothing about the
// ramp is imprecise. What was imprecise was knowing what point of the music each deck would be at
// when that ramp ran, because `currentTime` on a media element is a staircase that updates at the
// rendering quantum. But the function underneath that staircase is exactly linear - position
// advances at playbackRate, with no jitter, because it is derived from the same audio clock - so
// fitting a line through a second of readings recovers the true position far below the step size.
// Sixty readings of a 20ms staircase pin the phase to well under a millisecond.
//
// With that, alignment stops needing a new source node: the bar line of each track is known on the
// shared clock, and the transition is placed against it.

/** One reading of a deck's media position against the audio clock. */
export interface ClockSample {
    media: number;
    context: number;
}

export interface ClockFit {
    /**
     * Media position at context time zero.
     *
     * Carries a constant bias of about half the element's update quantum - the staircase reports
     * the position as of the last audio callback, so every reading is a little stale and least
     * squares recovers the stale line rather than the true one. Around ten milliseconds, and
     * deliberately not corrected: removing it would mean guessing whether a given engine floors or
     * rounds, and every use here is either a rate (unaffected) or a comparison between two decks
     * measured the same way (cancels). What was replaced was a hundred and fifty milliseconds of
     * jitter, which cancels nowhere.
     */
    offset: number;
    /** Media seconds per context second. The deck's effective playback rate, measured. */
    rate: number;
    /** RMS of the residuals, in seconds. The staircase alone lands around a third of its step. */
    error: number;
    samples: number;
}

/**
 * Least squares through the readings.
 *
 * Deliberately unweighted and un-robust: the readings are a quantisation of a straight line, so the
 * residuals are uniform rather than heavy-tailed, and plain least squares is the right estimator
 * for that. Anything that is not on the line - a seek, a stall - is not an outlier to be
 * down-weighted, it is a different line, and the sampler below throws the window away instead.
 */
export const fitClock = (samples: readonly ClockSample[]): ClockFit | null => {
    const count = samples.length;
    if (count < 4) return null;

    let meanX = 0;
    let meanY = 0;
    for (const sample of samples) {
        meanX += sample.context;
        meanY += sample.media;
    }
    meanX /= count;
    meanY /= count;

    let top = 0;
    let bottom = 0;
    for (const sample of samples) {
        const dx = sample.context - meanX;
        top += dx * (sample.media - meanY);
        bottom += dx * dx;
    }
    // Every reading at the same instant: no baseline, no slope.
    if (!(bottom > 0)) return null;

    const rate = top / bottom;
    const offset = meanY - rate * meanX;
    let squared = 0;
    for (const sample of samples) {
        squared += (sample.media - (offset + rate * sample.context)) ** 2;
    }
    return { offset, rate, error: Math.sqrt(squared / count), samples: count };
};

/** How much history the fit runs over. Long enough to average the staircase, short enough to be now. */
const WINDOW_SEC = 1.5;
/**
 * How far a reading may fall from the fitted line before the window is thrown away.
 *
 * A seek, a stall or a track change does not bend the line, it replaces it, and a fit spanning both
 * describes neither. Generous enough that the staircase itself never trips it - a media element's
 * position quantum is tens of milliseconds at worst.
 */
const BREAK_SEC = 0.12;
/** Past this the readings are not describing a steady playback and nothing should be built on them. */
const MAX_TRUSTED_ERROR_SEC = 0.05;

export interface DeckClock {
    /** One reading. Driven by the same timer that feeds the level analyser. */
    sample: (media: number, context: number) => void;
    /** Where the deck will be at a given audio-clock time, or null while nothing is established. */
    positionAt: (contextTime: number) => number | null;
    /** When the deck will reach a given media position, or null. The inverse, and the useful half. */
    reaches: (mediaPosition: number, notBefore: number) => number | null;
    /** The measured rate, which is the element's playbackRate as the audio actually ran. */
    rate: () => number | null;
    fit: () => ClockFit | null;
    reset: () => void;
}

export const createDeckClock = (): DeckClock => {
    let samples: ClockSample[] = [];
    let cached: ClockFit | null = null;

    const refit = () => {
        cached = fitClock(samples);
        return cached;
    };

    const trusted = () => {
        const fit = cached ?? refit();
        return fit && fit.error <= MAX_TRUSTED_ERROR_SEC && fit.rate > 0.1 ? fit : null;
    };

    return {
        sample: (media, context) => {
            if (!Number.isFinite(media) || !Number.isFinite(context)) return;
            const fit = cached;
            if (fit && Math.abs(media - (fit.offset + fit.rate * context)) > BREAK_SEC) {
                samples = [];
                cached = null;
            }
            samples.push({ media, context });
            while (samples.length && context - samples[0].context > WINDOW_SEC) samples.shift();
            refit();
        },
        positionAt: contextTime => {
            const fit = trusted();
            return fit ? fit.offset + fit.rate * contextTime : null;
        },
        reaches: (mediaPosition, notBefore) => {
            const fit = trusted();
            if (!fit) return null;
            const when = (mediaPosition - fit.offset) / fit.rate;
            return when >= notBefore ? when : null;
        },
        rate: () => trusted()?.rate ?? null,
        fit: () => cached,
        reset: () => {
            samples = [];
            cached = null;
        },
    };
};
