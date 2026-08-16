import { estimateTempo, rmsDb, spectralFlux, SILENCE_DB } from './signalAnalysis';

// src/services/automix/trackProfile.ts
// One pass over a decoded track, producing the couple of hundred bytes a transition needs to know
// about a song it has not played yet. Pure: a mono Float32Array in, a plain object out.
//
// This is the half the live analyser can never do. An AnalyserNode can only describe the track
// that is currently sounding, and the whole problem with a song change is that the interesting
// track is the one that has not started. Everything here - where the silence is, whether the ends
// are loud or decaying, the beat grid, the key - is about the *incoming* song.

/** Bumped whenever the maths changes, so stored profiles from an older build are re-measured. */
export const TRACK_PROFILE_VERSION = 1;

/**
 * What the analysis runs at.
 *
 * Everything measured here lives well under 11kHz, and decodeAudioData resamples to whatever rate
 * the context was created at, so asking for 22.05kHz turns a four-minute track from ~80MB of
 * float samples into ~10MB for free - no second render pass, no resampler of our own.
 */
export const PROFILE_SAMPLE_RATE = 22050;

const FFT_SIZE = 2048;
const HOP = 512;
/** Onsets live below ~5kHz; above it is mostly cymbal wash, which blurs the beat. */
const FLUX_CEILING_HZ = 5000;
/** Chroma from C2 up: below it the bins are too wide to tell one semitone from the next. */
const CHROMA_MIN_HZ = 65;
/** Above this it is mostly harmonics and noise, which flatten the profile. */
const CHROMA_MAX_HZ = 2000;
/** Relative to the track's own loudest frame - a threshold in absolute dBFS would be a guess. */
const SILENCE_BELOW_PEAK_DB = 40;
/** How much of each end the slope is measured over. Long enough to see a fade develop. */
const EDGE_WINDOW_SEC = 10;
/**
 * How much of each end decides whether it is "hot".
 *
 * Deliberately much shorter than the slope window: the question is whether the track is at full
 * level *at the moment it stops*, and averaging that over ten seconds of a twelve-second track
 * compares the edge against itself and answers yes every time.
 */
const HOT_WINDOW_SEC = 1.5;
/** Within this of the track's own average level, an edge counts as being at full level. */
const HOT_EDGE_DB = 6;
/** Frames between yields, so a four-minute track does not hold the main thread for its whole scan. */
const YIELD_EVERY = 512;

export interface TrackProfile {
    version: number;
    /**
     * Only the beginning of the file was analysed, so every field about the END of the track is
     * null rather than wrong.
     *
     * This is what a track looks like when the only bytes we were allowed to read were a range
     * request off the front of it. A tail range cannot be used: strip a file's container header
     * and nothing will decode the rest, so the end of an uncached track is simply not knowable
     * without downloading it.
     */
    partial: boolean;
    /** Seconds actually analysed - NOT the track length when `partial`. */
    duration: number;
    /** Seconds of near-silence before the track starts sounding. */
    leadIn: number;
    /** Seconds of near-silence after it stops. Null when only the head was read. */
    leadOut: number | null;
    /** The track is already at full level as it starts - no intro to hide a blend in. */
    startsHot: boolean;
    /** It is still at full level when it stops - no decaying tail to blend under. */
    endsHot: boolean | null;
    /** dB per second across the first EDGE_WINDOW_SEC of sound. Positive = building. */
    introSlope: number;
    /** dB per second across the last EDGE_WINDOW_SEC. Negative = fading or decaying out. */
    outroSlope: number | null;
    /** RMS of the sounding part, dBFS. */
    loudness: number;
    bpm: number | null;
    /** Seconds from the start of the track to a beat of the grid. Meaningless without bpm. */
    beatOffset: number;
    /** Tonic as a pitch class, 0 = C. -1 when nothing correlated well enough. */
    key: number;
    major: boolean;
    /** 0..1, from how far the winning key stands above the runner-up. */
    keyConfidence: number;
}

/**
 * Iterative radix-2 FFT, in place, real input.
 *
 * Hand-rolled rather than pulled in: it is thirty lines, it runs once per track in the background,
 * and the alternative is a dependency in the bundle of a music player that already ships an FFT in
 * the browser it runs on - just not one reachable from a decoded buffer.
 */
const fft = (real: Float64Array, imag: Float64Array) => {
    const n = real.length;
    for (let i = 1, j = 0; i < n; i += 1) {
        let bit = n >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) {
            [real[i], real[j]] = [real[j], real[i]];
            [imag[i], imag[j]] = [imag[j], imag[i]];
        }
    }
    for (let len = 2; len <= n; len <<= 1) {
        const angle = (-2 * Math.PI) / len;
        const wReal = Math.cos(angle);
        const wImag = Math.sin(angle);
        for (let i = 0; i < n; i += len) {
            let curReal = 1;
            let curImag = 0;
            for (let k = 0; k < len / 2; k += 1) {
                const aReal = real[i + k];
                const aImag = imag[i + k];
                const bReal = real[i + k + len / 2] * curReal - imag[i + k + len / 2] * curImag;
                const bImag = real[i + k + len / 2] * curImag + imag[i + k + len / 2] * curReal;
                real[i + k] = aReal + bReal;
                imag[i + k] = aImag + bImag;
                real[i + k + len / 2] = aReal - bReal;
                imag[i + k + len / 2] = aImag - bImag;
                const nextReal = curReal * wReal - curImag * wImag;
                curImag = curReal * wImag + curImag * wReal;
                curReal = nextReal;
            }
        }
    }
};

/** Krumhansl-Schmuckler key profiles: how much each scale degree is used in major and minor. */
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

const correlate = (a: readonly number[], b: readonly number[]) => {
    const meanA = a.reduce((sum, value) => sum + value, 0) / a.length;
    const meanB = b.reduce((sum, value) => sum + value, 0) / b.length;
    let top = 0;
    let leftSq = 0;
    let rightSq = 0;
    for (let index = 0; index < a.length; index += 1) {
        const left = a[index] - meanA;
        const right = b[index] - meanB;
        top += left * right;
        leftSq += left * left;
        rightSq += right * right;
    }
    return leftSq > 0 && rightSq > 0 ? top / Math.sqrt(leftSq * rightSq) : 0;
};

export interface KeyEstimate {
    key: number;
    major: boolean;
    confidence: number;
}

/**
 * Best-correlating key for a 12-bin chroma vector, and how clearly it won.
 *
 * Correlation against both templates at all twelve rotations is the standard method and is right
 * roughly three times in four on real pop - good enough to *choose between transitions*, which is
 * the only thing the answer is ever used for. It is nowhere near good enough to act on, and the
 * confidence is reported so a caller can decline rather than trust a coin flip.
 */
export const keyFromChroma = (chroma: readonly number[]): KeyEstimate => {
    let best = { key: -1, major: true, score: -Infinity };
    let runnerUp = -Infinity;

    for (let rotation = 0; rotation < 12; rotation += 1) {
        const rotated = chroma.map((_, index) => chroma[(index + rotation) % 12]);
        for (const major of [true, false]) {
            const score = correlate(rotated, major ? MAJOR_PROFILE : MINOR_PROFILE);
            if (score > best.score) {
                runnerUp = best.score;
                best = { key: rotation, major, score };
            } else if (score > runnerUp) {
                runnerUp = score;
            }
        }
    }

    if (best.key < 0 || !Number.isFinite(best.score) || best.score <= 0) {
        return { key: -1, major: true, confidence: 0 };
    }
    const margin = Number.isFinite(runnerUp) ? Math.max(0, best.score - runnerUp) : 0;
    return {
        key: best.key,
        major: best.major,
        // Both halves matter: a strong fit that a dozen other keys fit equally well says nothing.
        confidence: Math.min(1, Math.max(0, best.score) * Math.min(1, margin / 0.15)),
    };
};

/** Least-squares slope of a dB series, per second. */
const slopePerSec = (values: readonly number[], hopSec: number) => {
    const count = values.length;
    if (count < 2) return 0;
    const meanX = (count - 1) / 2;
    const meanY = values.reduce((sum, value) => sum + value, 0) / count;
    let top = 0;
    let bottom = 0;
    for (let index = 0; index < count; index += 1) {
        const dx = index - meanX;
        top += dx * (values[index] - meanY);
        bottom += dx * dx;
    }
    return bottom > 0 ? (top / bottom) / hopSec : 0;
};

const yieldToUi = () => new Promise<void>(resolve => { setTimeout(resolve, 0); });

/**
 * Measures one decoded track.
 *
 * Async only so the scan can let go of the main thread every so often: a four-minute track is
 * about ten thousand transforms, which is a fraction of a second of work but an obvious stutter if
 * it happens in one block while lyrics are animating.
 */
export const analyseTrack = async (
    mono: Float32Array,
    sampleRate: number,
    /** Set when these samples are the head of a longer file, so the tail fields must stay null. */
    options: { partial?: boolean } = {},
): Promise<TrackProfile | null> => {
    const duration = mono.length / sampleRate;
    if (!(duration > 1) || !(sampleRate > 0)) return null;

    const hopSec = HOP / sampleRate;
    const bins = FFT_SIZE / 2;
    const binHz = sampleRate / FFT_SIZE;
    const fluxBins = Math.max(8, Math.round(FLUX_CEILING_HZ / binHz));
    const real = new Float64Array(FFT_SIZE);
    const imag = new Float64Array(FFT_SIZE);
    const spectrum = new Float32Array(bins);
    const previous = new Float32Array(bins);
    const frame = new Float32Array(FFT_SIZE);

    // Hann, precomputed: a rectangular window smears every partial across neighbouring bins, which
    // is fatal for chroma - the leakage from one note lands squarely on its neighbours.
    const window = new Float64Array(FFT_SIZE);
    for (let index = 0; index < FFT_SIZE; index += 1) {
        window[index] = 0.5 - 0.5 * Math.cos((2 * Math.PI * index) / (FFT_SIZE - 1));
    }

    // Which pitch class each bin belongs to, or -1 for the bins chroma ignores.
    const binPitchClass = new Int8Array(bins);
    for (let index = 0; index < bins; index += 1) {
        const hz = index * binHz;
        binPitchClass[index] = hz >= CHROMA_MIN_HZ && hz <= CHROMA_MAX_HZ
            ? ((Math.round(12 * Math.log2(hz / 440) + 69) % 12) + 12) % 12
            : -1;
    }

    const levels: number[] = [];
    const envelope: number[] = [];
    const chroma = new Array<number>(12).fill(0);
    let energy = 0;
    let counted = 0;
    let frames = 0;

    for (let start = 0; start + FFT_SIZE <= mono.length; start += HOP) {
        frame.set(mono.subarray(start, start + FFT_SIZE));
        const level = rmsDb(frame);
        levels.push(level);

        for (let index = 0; index < FFT_SIZE; index += 1) {
            real[index] = frame[index] * window[index];
            imag[index] = 0;
        }
        fft(real, imag);

        for (let index = 0; index < bins; index += 1) {
            const magnitude = Math.hypot(real[index], imag[index]);
            // dB domain, matching the live analyser's input so the same flux maths applies.
            spectrum[index] = magnitude > 0 ? Math.max(SILENCE_DB, 20 * Math.log10(magnitude)) : SILENCE_DB;
            const pitchClass = binPitchClass[index];
            if (pitchClass >= 0) chroma[pitchClass] += magnitude;
        }

        if (frames > 0) envelope.push(spectralFlux(spectrum, previous, fluxBins));
        previous.set(spectrum);

        if (level > SILENCE_DB) {
            energy += 10 ** (level / 10);
            counted += 1;
        }
        frames += 1;
        if (frames % YIELD_EVERY === 0) await yieldToUi();
    }

    if (!levels.length) return null;

    // Looped rather than spread: a long track has tens of thousands of frames, and Math.max(...)
    // passes every one of them as an argument.
    let peak = SILENCE_DB;
    for (const level of levels) if (level > peak) peak = level;
    // Nothing ever sounded. Every threshold below is relative to the peak, so without this a file
    // of pure digital silence describes itself as a track that is loud from end to end.
    if (peak <= SILENCE_DB) return null;
    const floor = peak - SILENCE_BELOW_PEAK_DB;
    const first = levels.findIndex(level => level > floor);
    let last = -1;
    for (let index = levels.length - 1; index >= 0; index -= 1) {
        if (levels[index] > floor) { last = index; break; }
    }
    if (first < 0 || last < first) return null;

    const sounding = levels.slice(first, last + 1);
    const mean = (values: readonly number[]) =>
        values.reduce((sum, value) => sum + value, 0) / values.length;
    const edgeFrames = Math.max(2, Math.round(EDGE_WINDOW_SEC / hopSec));
    const hotFrames = Math.max(2, Math.round(HOT_WINDOW_SEC / hopSec));
    const head = sounding.slice(0, Math.min(edgeFrames, sounding.length));
    const tail = sounding.slice(Math.max(0, sounding.length - edgeFrames));
    const average = mean(sounding);

    const tempo = estimateTempo(envelope, hopSec);
    // estimateTempo reports the phase relative to the END of the envelope; the grid is wanted from
    // the start of the track, so it is walked back a whole number of periods.
    const lastBeatSec = tempo
        ? (envelope.length - 1 - tempo.beatOffsetHops) * hopSec + FFT_SIZE / (2 * sampleRate)
        : 0;
    const beatOffset = tempo && tempo.periodSec > 0
        ? ((lastBeatSec % tempo.periodSec) + tempo.periodSec) % tempo.periodSec
        : 0;

    const key = keyFromChroma(chroma);

    // Everything about the end of a truncated file describes the truncation, not the music.
    const partial = options.partial === true;

    return {
        version: TRACK_PROFILE_VERSION,
        partial,
        duration,
        leadIn: first * hopSec,
        leadOut: partial ? null : Math.max(0, duration - (last * hopSec + FFT_SIZE / sampleRate)),
        // Averaged over a second or so rather than read off one frame: a single loud transient at
        // the top of a track is a count-in, not a track that starts at full tilt.
        startsHot: mean(sounding.slice(0, Math.min(hotFrames, sounding.length))) > average - HOT_EDGE_DB,
        endsHot: partial ? null : mean(sounding.slice(Math.max(0, sounding.length - hotFrames))) > average - HOT_EDGE_DB,
        introSlope: slopePerSec(head, hopSec),
        outroSlope: partial ? null : slopePerSec(tail, hopSec),
        loudness: counted ? 10 * Math.log10(energy / counted) : SILENCE_DB,
        bpm: tempo?.bpm ?? null,
        beatOffset,
        key: key.key,
        major: key.major,
        keyConfidence: key.confidence,
    };
};
