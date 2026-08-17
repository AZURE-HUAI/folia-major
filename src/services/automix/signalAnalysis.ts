// src/services/automix/signalAnalysis.ts
// The measurement maths behind a blend: how loud a deck is, what tempo it is running at, and what
// shape the crossfade should take as a result. Pure - arrays and numbers in, numbers out - so
// every rule here is exercised without an audio device.

/** Slowest and fastest tempo worth looking for; outside this a "beat" is an artefact. */
const MIN_BPM = 60;
const MAX_BPM = 180;
/** Below this the autocorrelation peak is not distinguishable from its own noise floor. */
export const MIN_TEMPO_CONFIDENCE = 0.35;

/** Floor for every level reading. Digital silence and -Infinity both land here. */
export const SILENCE_DB = -90;

/** A dense, loud outro: it will bury whatever starts underneath it, so hand over early. */
const LOUD_OUTRO_DB = -14;
/** A decaying tail: letting it breathe sounds better than shouldering it aside. */
const QUIET_OUTRO_DB = -30;
/** Below this the track has already finished in every sense that matters; waiting is a hole. */
const SILENT_TAIL_DB = -45;
export const CROSSOVER_EARLY = 0.35;
export const CROSSOVER_LATE = 0.55;

/** Ceiling on how far the outgoing deck is pulled down to make room for the incoming one. */
export const MAX_TRIM_DB = 6;

/** How far the beat grid is allowed to stretch or shorten a planned blend. */
const BEAT_SNAP_TOLERANCE = 0.25;

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

export const dbToGain = (db: number): number => 10 ** (db / 20);

/** RMS of one analyser frame, in dBFS. */
export const rmsDb = (samples: Float32Array): number => {
    if (!samples.length) return SILENCE_DB;
    let sum = 0;
    for (let index = 0; index < samples.length; index += 1) {
        sum += samples[index] * samples[index];
    }
    const rms = Math.sqrt(sum / samples.length);
    return rms > 0 ? Math.max(SILENCE_DB, 20 * Math.log10(rms)) : SILENCE_DB;
};

/**
 * Spectral flux: how much energy appeared since the previous frame.
 *
 * Only rises count. A note or a drum hit starts as energy arriving across many bins at once, while
 * energy leaving is just the previous sound decaying - counting decay too would smear every onset
 * into the sustain that follows it and leave nothing periodic to find.
 */
export const spectralFlux = (current: Float32Array, previous: Float32Array, bins: number): number => {
    const limit = Math.min(bins, current.length, previous.length);
    let flux = 0;
    for (let index = 0; index < limit; index += 1) {
        const now = Number.isFinite(current[index]) ? current[index] : SILENCE_DB;
        const before = Number.isFinite(previous[index]) ? previous[index] : SILENCE_DB;
        if (now > before) flux += now - before;
    }
    return flux;
};

export interface TempoEstimate {
    bpm: number;
    periodSec: number;
    /** 0..1, from how far the winning lag stands above the average lag. */
    confidence: number;
    /** Hops before the newest envelope sample where the most recent beat fell. */
    beatOffsetHops: number;
}

/**
 * Weight on a candidate tempo before its correlation is judged.
 *
 * Autocorrelation cannot tell a tempo from half or double of it - both are genuinely periodic -
 * and picking the raw peak lands on the wrong octave often enough to be useless. A bump centred
 * on 120 BPM is the standard tie-breaker and costs one exponential per lag.
 */
const tempoPrior = (bpm: number) => Math.exp(-0.5 * (Math.log2(bpm / 120) / 0.55) ** 2);

/**
 * Tempo and beat phase from an onset-strength envelope.
 *
 * Autocorrelation rather than a comb filter bank: one pass over a few hundred samples, no
 * dependency, and the by-product we actually need - the lag of the strongest self-similarity - is
 * the beat period directly. Returns null rather than a guess when the envelope is too short or
 * carries no periodicity at all, because a wrong grid is worse than no grid.
 */
export const estimateTempo = (envelope: readonly number[], hopSec: number): TempoEstimate | null => {
    if (!(hopSec > 0)) return null;
    const count = envelope.length;
    const minLag = Math.max(2, Math.round(60 / (MAX_BPM * hopSec)));
    const maxLag = Math.round(60 / (MIN_BPM * hopSec));
    // Three periods of the slowest tempo, or the longest lags are measured over a handful of
    // samples and win on noise alone.
    if (count < maxLag * 3) return null;

    let mean = 0;
    for (const value of envelope) mean += value;
    mean /= count;

    // Half-wave rectified around the mean: only above-average onsets carry the pulse.
    const centred = new Float64Array(count);
    let energy = 0;
    for (let index = 0; index < count; index += 1) {
        const value = Math.max(0, envelope[index] - mean);
        centred[index] = value;
        energy += value * value;
    }
    if (energy <= 0) return null;

    let bestLag = 0;
    let bestScore = 0;
    let scoreSum = 0;
    let scored = 0;

    for (let lag = minLag; lag <= maxLag; lag += 1) {
        let sum = 0;
        for (let index = lag; index < count; index += 1) {
            sum += centred[index] * centred[index - lag];
        }
        // Divided by the overlap: a long lag correlates over fewer samples and would otherwise
        // lose to a short one purely by construction.
        const score = (sum / (count - lag)) * tempoPrior(60 / (lag * hopSec));
        scoreSum += score;
        scored += 1;
        if (score > bestScore) {
            bestScore = score;
            bestLag = lag;
        }
    }

    const average = scored ? scoreSum / scored : 0;
    if (!bestLag || bestScore <= 0 || average <= 0) return null;

    // Which offset within the period the beats actually sit on: sum every sample the grid would
    // land on and keep the alignment that collects the most onset strength.
    let beatOffsetHops = 0;
    let bestPhase = -1;
    for (let offset = 0; offset < bestLag; offset += 1) {
        let sum = 0;
        for (let index = count - 1 - offset; index >= 0; index -= bestLag) {
            sum += centred[index];
        }
        if (sum > bestPhase) {
            bestPhase = sum;
            beatOffsetHops = offset;
        }
    }

    return {
        bpm: 60 / (bestLag * hopSec),
        periodSec: bestLag * hopSec,
        confidence: clamp((bestScore / average - 1) / 2, 0, 1),
        beatOffsetHops,
    };
};

/**
 * How far into the blend the two tracks should change places.
 *
 * 0.5 - the plain equal-power midpoint - assumes both tracks are equally loud, and mastering
 * levels vary by 10dB across a library, which is why a symmetric fade so often sounds like the
 * old song is sitting on top of the new one. The outgoing track's own measured level is the one
 * thing known before the incoming track has made a sound, so it sets the handover point: a loud
 * dense outro gives way early, a quiet decaying tail is allowed to run.
 */
export const crossoverFor = (outgoingDb: number | null): number => {
    if (outgoingDb === null || !Number.isFinite(outgoingDb)) {
        return (CROSSOVER_EARLY + CROSSOVER_LATE) / 2;
    }
    // Not monotonic on purpose. A quiet tail is worth waiting for; a track that has already faded
    // to nothing is not, and holding the incoming one back for it leaves an audible hole.
    if (outgoingDb <= SILENT_TAIL_DB) return CROSSOVER_EARLY;
    const loudness = clamp((outgoingDb - QUIET_OUTRO_DB) / (LOUD_OUTRO_DB - QUIET_OUTRO_DB), 0, 1);
    return CROSSOVER_LATE + (CROSSOVER_EARLY - CROSSOVER_LATE) * loudness;
};

/**
 * dB to pull the outgoing deck down by so the incoming track is not buried under it.
 *
 * Only ever an attenuation, and only ever of the track that is leaving. Lifting the incoming one
 * instead would risk clipping, and would have to be undone afterwards - an audible swell on every
 * song change.
 */
export const trimForBalance = (outgoingDb: number, incomingDb: number): number =>
    clamp(outgoingDb - incomingDb, 0, MAX_TRIM_DB);

export interface BlendShapeInput {
    /** Blend length the planner asked for, already clamped to what the track has left. */
    overlap: number;
    /** Recent level of the outgoing deck in dBFS, or null when it was never measured. */
    outgoingDb: number | null;
    /** Seconds from the start of the blend to the outgoing track's next beat, or null. */
    nextBeatIn: number | null;
    /** Beat period of the outgoing track in seconds, or null. */
    periodSec: number | null;
    minOverlap: number;
    /** Everything the outgoing track actually has left. */
    maxOverlap: number;
}

export interface BlendShape {
    overlap: number;
    crossover: number;
    /** True when the beat grid moved the length. Reported, so a claim can be checked. */
    snappedToBeat: boolean;
}

/**
 * Turns the planner's length plus whatever was measured into the blend that gets scheduled.
 *
 * The beat snap moves the crossover, not the start: the start is fixed by when the incoming deck
 * managed to load, and the crossover - the one moment in a blend where both tracks are equally
 * present - is what a listener hears as the transition happening. Landing it on a beat of the
 * outgoing track is the whole of the alignment that is honestly available without stretching
 * time, which no browser can do without shifting pitch with it.
 */
export const planBlendShape = (input: BlendShapeInput): BlendShape => {
    const crossover = crossoverFor(input.outgoingDb);
    const shape: BlendShape = { overlap: input.overlap, crossover, snappedToBeat: false };

    const { nextBeatIn, periodSec } = input;
    if (nextBeatIn === null || periodSec === null || !(periodSec > 0)) return shape;

    const low = Math.max(input.minOverlap, input.overlap * (1 - BEAT_SNAP_TOLERANCE));
    const high = Math.min(input.maxOverlap, input.overlap * (1 + BEAT_SNAP_TOLERANCE));
    if (low > high) return shape;

    // Beats fall at nextBeatIn + k periods; take whichever sits closest to the unsnapped crossover.
    const target = input.overlap * crossover;
    const beat = nextBeatIn + Math.round((target - nextBeatIn) / periodSec) * periodSec;
    if (!(beat > 0)) return shape;

    const overlap = beat / crossover;
    if (overlap < low || overlap > high) return shape;

    return { overlap, crossover, snappedToBeat: true };
};

/**
 * The pair of gain curves for one blend.
 *
 * Both sides read the same warped progress, so cos^2 + sin^2 keeps the summed power at exactly one
 * wherever the crossover is put: moving the handover changes the two tracks' relative speeds
 * without ever letting the blend sag or swell in the middle.
 */
export const buildCrossfadeCurves = (crossover: number, points = 64): {
    out: Float32Array;
    in: Float32Array;
} => {
    const pivot = clamp(crossover, 0.15, 0.85);
    const out = new Float32Array(points);
    const incoming = new Float32Array(points);

    for (let index = 0; index < points; index += 1) {
        const progress = index / (points - 1);
        // Piecewise linear through (0,0) (pivot,0.5) (1,1): monotonic, and exact at both ends.
        const warped = progress <= pivot
            ? (progress / pivot) * 0.5
            : 0.5 + ((progress - pivot) / (1 - pivot)) * 0.5;
        const angle = warped * (Math.PI / 2);
        out[index] = Math.cos(angle);
        incoming[index] = Math.sin(angle);
    }

    return { out, in: incoming };
};
