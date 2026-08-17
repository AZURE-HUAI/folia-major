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
 * Headroom the summed blend is given while both masters are stacked.
 *
 * Equal power guarantees constant POWER, which is not constant PEAK: two modern masters both
 * sitting a decibel under full scale can and do sum past it, and what that sounds like is a few
 * hundred milliseconds of distortion in the middle of every song change. A decibel and a half is
 * the standard inter-sample allowance and is inaudible as a level change.
 */
export const BLEND_HEADROOM_DB = 1.5;

/**
 * How much of the headroom applies at a given point through the blend.
 *
 * Zero at both ends and one in the middle, so the curves still start and finish at exactly unity.
 * That is what makes this free: a flat 1.5dB dip would have to be handed back at the end of every
 * transition, which is a 1.5dB swell on the incoming track the moment it is alone.
 */
const headroomBell = (progress: number) => Math.sin(clamp(progress, 0, 1) * Math.PI);

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
        const headroom = dbToGain(-BLEND_HEADROOM_DB * headroomBell(progress));
        out[index] = Math.cos(angle) * headroom;
        incoming[index] = Math.sin(angle) * headroom;
    }

    return { out, in: incoming };
};

// ---------------------------------------------------------------------------------------------
// Three bands, three seams
// ---------------------------------------------------------------------------------------------

/**
 * Where the spectrum is cut into the three regions a blend treats differently.
 *
 * One number per region rather than a filter bank: these same two edges define what the offline
 * analysis measures a track's tone as, and what the deck chain's three filters act on, so a single
 * pair keeps the measurement and the actuator describing the same thing.
 */
export const TONE_EDGE_HZ = [250, 4000] as const;
/** Centre of the middle region, geometrically. The peaking filter's frequency. */
export const TONE_MID_HZ = Math.round(Math.sqrt(TONE_EDGE_HZ[0] * TONE_EDGE_HZ[1]));

/** How far down the low end goes while the other deck owns it. Gone, without being a filter. */
const BASS_KILL_DB = 24;
/** How much of the top the outgoing track loses on its way out. */
const SWEEP_OUT_HIGH_DB = 9;
/** Fraction of the blend the low end takes to change hands. Short enough to read as one moment. */
const BASS_SWAP_WIDTH = 0.12;
/** Ceiling on the tone match. Past this it stops being "arriving in character" and is an effect. */
export const MAX_TILT_DB = 3;

export interface BandBlendRequest {
    /** Where through the blend the two tracks change places, 0..1. */
    crossover: number;
    /** The low end changes hands as a step at the crossover instead of crossfading through it. */
    swapBass: boolean;
    /** The outgoing track is filtered out of the way as it leaves, not only turned down. */
    sweepOut: boolean;
    /** dB the incoming deck's mid and top start bent by, so it arrives wearing the outgoing
     *  track's tone and returns to its own. Clamped; zero disables the match. */
    tiltDb: readonly [number, number];
    points?: number;
}

/** Three dB curves per deck, in the order [low, mid, high]. */
export interface BandBlendCurves {
    out: [Float32Array, Float32Array, Float32Array];
    in: [Float32Array, Float32Array, Float32Array];
}

/**
 * The per-band shape of one blend, on top of the overall gain curve.
 *
 * One gain curve for the whole spectrum is the thing that makes a crossfade sound like a crossfade:
 * every frequency of both tracks is present through the middle of it, so two arrangements, two bass
 * lines and two sets of cymbals are all stacked at once. Giving each region its own seam is the
 * answer the literature reaches for as well - the ideal version picks a seam per frequency bin, by
 * graph cut over a spectrogram, which needs phase-preserving resynthesis and is not something a
 * browser does to live audio. Three regions is the same idea at the resolution a pair of shelves and
 * a bell can actually act on, and it costs three automation curves.
 *
 * What each region does, and why:
 *
 * - LOW changes hands at a stroke. Almost all of the mud in an overlap is below 250Hz, where two
 *   bass lines double the energy, beat against each other and cancel. One track owns it at a time.
 * - MID crossfades with the overall curve, unshaped. It is where both tracks are recognisable, and
 *   it is the region the listener is following the transition in.
 * - HIGH leaves early on the outgoing side. Rolling the top off a departing track is what makes it
 *   read as being pulled away rather than merely turned down, and it clears the cymbals out of the
 *   way of the arriving ones, which are the other thing that stacks badly.
 *
 * The incoming deck's mid and top additionally start bent towards the outgoing track's tone and
 * relax to flat by the crossover: a dull master following a bright one is a step in timbre at the
 * seam, and this walks it instead.
 */
export const buildBandCurves = (request: BandBlendRequest): BandBlendCurves => {
    const points = request.points ?? 64;
    const seam = clamp(request.crossover, 0.15, 0.85);
    const width = Math.max(0.02, Math.min(BASS_SWAP_WIDTH, seam, 1 - seam));
    const tiltMid = clamp(request.tiltDb[0], -MAX_TILT_DB, MAX_TILT_DB);
    const tiltHigh = clamp(request.tiltDb[1], -MAX_TILT_DB, MAX_TILT_DB);

    const band = () => [
        new Float32Array(points), new Float32Array(points), new Float32Array(points),
    ] as [Float32Array, Float32Array, Float32Array];
    const out = band();
    const incoming = band();

    for (let index = 0; index < points; index += 1) {
        const progress = index / (points - 1);
        // 0 while the outgoing track still owns the low end, 1 once the incoming one has it.
        const handover = clamp((progress - (seam - width / 2)) / width, 0, 1);
        // Nothing at the seam, then accelerating: the top thins out as the track leaves rather
        // than stepping down the moment the two change places.
        const leaving = clamp((progress - seam) / Math.max(1e-3, 1 - seam), 0, 1) ** 2;
        // Full at the start of the blend, gone by the time the two change places.
        const settling = clamp(1 - progress / Math.max(1e-3, seam), 0, 1);

        if (request.swapBass) {
            out[0][index] = -BASS_KILL_DB * handover;
            incoming[0][index] = -BASS_KILL_DB * (1 - handover);
        }
        if (request.sweepOut) {
            out[2][index] = -SWEEP_OUT_HIGH_DB * leaving;
        }
        incoming[1][index] = tiltMid * settling;
        incoming[2][index] = tiltHigh * settling;
    }

    return { out, in: incoming };
};

/**
 * How far apart two tracks' tone sits, as the bend that would close the gap.
 *
 * Shares are used rather than absolute levels because the two tracks are already being matched for
 * loudness elsewhere; what is left is the SHAPE, and a share is what a shape is. The answer is the
 * mid and top corrections for the incoming deck, in dB, so that a bright track arriving after a
 * dull one is briefly dulled to match.
 */
export const toneTilt = (
    outgoing: readonly number[] | null | undefined,
    incoming: readonly number[] | null | undefined,
): [number, number] => {
    if (!outgoing || !incoming || outgoing.length < 3 || incoming.length < 3) return [0, 0];
    const bend = (band: number) => {
        const a = outgoing[band];
        const b = incoming[band];
        if (!(a > 0) || !(b > 0)) return 0;
        return clamp(10 * Math.log10(a / b), -MAX_TILT_DB, MAX_TILT_DB);
    };
    return [bend(1), bend(2)];
};

// ---------------------------------------------------------------------------------------------
// Loudness, in the unit broadcasting settled on
// ---------------------------------------------------------------------------------------------

/**
 * The offset that turns mean K-weighted power into LUFS, from ITU-R BS.1770.
 *
 * Exposed rather than folded in because the same weighting is applied twice - once in software over
 * a decoded file, once as two biquads in front of the live tap - and the two have to land in the
 * same unit or every level comparison between an offline profile and a playing deck is nonsense.
 */
export const LUFS_OFFSET_DB = -0.691;

/**
 * K-weighting, as two biquad sections. The filter every loudness number in broadcasting goes
 * through.
 *
 * RMS answers "how much energy is there", which is not the question. Two tracks at the same RMS
 * differ by several decibels of perceived loudness if one of them is bass-heavy, because the ear is
 * far less sensitive down there - so an RMS-matched blend leaves the denser master sounding louder,
 * which is exactly the "the old song is sitting on top of the new one" the balance correction exists
 * to remove. K-weighting is a shelf that lifts everything above ~1.7kHz by 4dB and a high-pass at
 * ~38Hz that discards rumble; what comes out correlates with loudness well enough that the entire
 * streaming industry normalises to it.
 *
 * Coefficients derived from the analog prototype at the caller's sample rate rather than copied from
 * the 48kHz table in the standard: the analysis runs at 22.05kHz, where the tabulated numbers are a
 * different filter.
 */
export const kWeight = (samples: Float32Array, sampleRate: number): Float32Array => {
    const out = new Float32Array(samples.length);
    if (!(sampleRate > 0) || !samples.length) return out;

    // Stage 1: the head/torso shelf.
    const shelfHz = 1681.974450955533;
    const shelfGainDb = 3.999843853973347;
    const shelfQ = 0.7071752369554196;
    const k1 = Math.tan((Math.PI * shelfHz) / sampleRate);
    const vh = 10 ** (shelfGainDb / 20);
    const vb = vh ** 0.4996667741545416;
    const d0 = 1 + k1 / shelfQ + k1 * k1;
    const b = [
        (vh + (vb * k1) / shelfQ + k1 * k1) / d0,
        (2 * (k1 * k1 - vh)) / d0,
        (vh - (vb * k1) / shelfQ + k1 * k1) / d0,
    ];
    const a = [(2 * (k1 * k1 - 1)) / d0, (1 - k1 / shelfQ + k1 * k1) / d0];

    // Stage 2: the RLB high-pass.
    const hpHz = 38.13547087602444;
    const hpQ = 0.5003270373238773;
    const k2 = Math.tan((Math.PI * hpHz) / sampleRate);
    const d1 = 1 + k2 / hpQ + k2 * k2;
    const c = [(2 * (k2 * k2 - 1)) / d1, (1 - k2 / hpQ + k2 * k2) / d1];

    let x1 = 0; let x2 = 0; let y1 = 0; let y2 = 0;
    let p1 = 0; let p2 = 0; let q1 = 0; let q2 = 0;
    for (let index = 0; index < samples.length; index += 1) {
        const x = samples[index];
        const y = b[0] * x + b[1] * x1 + b[2] * x2 - a[0] * y1 - a[1] * y2;
        x2 = x1; x1 = x; y2 = y1; y1 = y;
        // b coefficients of the high-pass are exactly 1, -2, 1.
        const z = y - 2 * p1 + p2 - c[0] * q1 - c[1] * q2;
        p2 = p1; p1 = y; q2 = q1; q1 = z;
        out[index] = z;
    }
    return out;
};

// ---------------------------------------------------------------------------------------------
// Where the bar line is
// ---------------------------------------------------------------------------------------------

/** How many beats a bar is taken to be. Everything this player is likely to meet is in four. */
export const BEATS_PER_BAR = 4;

/**
 * Which beat of the bar is the "one", from where the kick drum falls.
 *
 * A beat grid says when the pulses are; it does not say which of them a bar starts on, and that is
 * the difference between a transition that lands and one that is a quarter note out for its whole
 * length. The evidence is in the bottom of the spectrum: on essentially all of the music this plays,
 * the bass drum marks the downbeat and the snare marks the backbeat, so summing low-band onset
 * strength at each of the four candidate phases and keeping the strongest is the whole method.
 *
 * A trained classifier does this better. This does not have to be better, it has to beat picking a
 * phase at random, which is what the alternative is.
 *
 * Returns seconds from the start of the envelope to a downbeat, or null when there is no grid or the
 * four phases are indistinguishable - a track with no drums has no downbeat to find this way, and
 * saying so is more useful than naming one.
 */
export const estimateDownbeat = (
    lowEnvelope: readonly number[],
    hopSec: number,
    periodSec: number,
    /** Seconds from the start of the envelope to any beat of the grid. */
    beatOffsetSec: number,
    beatsPerBar = BEATS_PER_BAR,
): number | null => {
    if (!(hopSec > 0) || !(periodSec > 0) || lowEnvelope.length < beatsPerBar * 4) return null;

    // The strongest frame within one hop either side, not the frame the arithmetic lands on. A kick
    // is one or two frames wide at this hop, and the grid is an estimate: sampling a single index
    // means a grid half a frame out reads the shoulder of every hit instead of the hit.
    const at = (seconds: number) => {
        const centre = Math.round(seconds / hopSec);
        if (centre < 0 || centre >= lowEnvelope.length) return null;
        let peak = lowEnvelope[centre];
        for (const index of [centre - 1, centre + 1]) {
            if (index >= 0 && index < lowEnvelope.length && lowEnvelope[index] > peak) {
                peak = lowEnvelope[index];
            }
        }
        return peak;
    };

    // The TYPICAL onset strength on each candidate phase, not the average one.
    //
    // A median rather than a mean, and that is the whole robustness of this. A downbeat is a thing
    // that happens every bar; an average is moved by one event, so a single loud moment anywhere in
    // a track - the first note after the leading silence, say - is enough to nominate whichever
    // phase it happened to land on. A median asks "does this phase usually carry a hit", which is
    // the question, and one transient cannot answer it.
    const middle = (values: number[]) => {
        if (!values.length) return 0;
        values.sort((a, b) => a - b);
        return values[values.length >> 1];
    };
    const scores: number[] = [];
    const span = lowEnvelope.length * hopSec;
    const barSec = periodSec * beatsPerBar;
    for (let phase = 0; phase < beatsPerBar; phase += 1) {
        const hits: number[] = [];
        for (let bar = 0; beatOffsetSec + phase * periodSec + bar * barSec <= span; bar += 1) {
            const value = at(beatOffsetSec + phase * periodSec + bar * barSec);
            if (value !== null) hits.push(value);
        }
        scores.push(middle(hits));
    }

    let best = 0;
    for (let phase = 1; phase < beatsPerBar; phase += 1) if (scores[phase] > scores[best]) best = phase;
    const mean = scores.reduce((sum, value) => sum + value, 0) / scores.length;

    // Two guards, ruling out two different kinds of nothing.
    //
    // Contrast: four phases that carry the same amount of onset are a track with no drums, or one
    // whose kick is on every beat, and picking the largest of four equal numbers is picking noise.
    //
    // Height: the winning phase has to stand above the envelope's own floor. Contrast alone passes
    // on a signal with no onsets at all, because the ratio between four tiny numbers is still a
    // ratio.
    let floor = 0;
    for (const value of lowEnvelope) floor += value;
    floor /= lowEnvelope.length;
    if (!(mean > 0) || scores[best] < mean * 1.25 || scores[best] < floor * 1.5) return null;

    return ((beatOffsetSec + best * periodSec) % (periodSec * beatsPerBar) + periodSec * beatsPerBar)
        % (periodSec * beatsPerBar);
};
