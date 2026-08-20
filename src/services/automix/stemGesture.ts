import type { StemName } from './stems';

// src/services/automix/stemGesture.ts
// The round-eleven handover, as arithmetic. No audio nodes, no clock - given the two windows'
// envelopes and a bar length it says when each stem changes hands and how the outgoing voice
// leaves.
//
// This is a PORT, not a design. Every number here was settled by blind listening tests over eleven
// rounds and several of them are counter-intuitive enough that they were nearly shipped the other
// way round; the reasoning is recorded beside each one so a later reader does not "fix" a result.
// If any of it is ever revisited it needs a listening test with a do-nothing control, not an
// argument - see the round ten and eleven verdicts.

/** Cell length the envelopes are measured at. 50ms, which is what the harness used. */
export const CELL_SEC = 0.05;

/**
 * How far below the window's own median level the outgoing voice has to get for its exit to be a
 * cut rather than a fade.
 *
 * -30 dB, and the value has a history. Round ten used -20, classified a -21 dB moment as a rest,
 * and the listener heard the cut anyway. Relative to the MIX's median in that window rather than to
 * full scale, because "quiet" only means anything against what else is playing.
 */
export const REST_DB = -30;

/** How long the cut takes. Half a second reads as an edit; shorter reads as a dropout. */
const CUT_SEC = 0.5;
/** The exit never starts at zero - the first moment of a window is where a splice lands. */
const EXIT_FLOOR_SEC = 0.05;
/**
 * Shortest a recede may be squeezed to before it stops being one.
 *
 * A second. Under it the outgoing voice does not recede, it disappears - which is a cut, placed at
 * a moment the rest search has already ruled out as too loud to cut in.
 */
const MIN_RECEDE_SEC = 1;
/**
 * Quiet enough that a cut takes nothing with it, so it may be as fast as the harness's.
 *
 * Fifteen dB below the threshold that admits a cut at all. Under this the vocal stem is at the
 * noise floor of the separation rather than at a quiet syllable, which is the case the half-second
 * cut was scored on - both rests measured in a real session sat at -56 and -58 dB.
 */
const DEEP_REST_DB = -45;
/** Longest a cut may stretch to when the rest it lands in is only just quiet enough. */
const SOFT_EXIT_SEC = 1.2;

/**
 * Where the drums change hands, as a fraction of the window.
 *
 * Snapped to a real bar line when one is in reach; this is only the target it reaches towards.
 */
const SWAP_TARGET = 0.42;
/**
 * How much blend may be left AFTER the low end has changed hands, in bars.
 *
 * SWAP_TARGET is a fraction and the gesture that follows it is a fixed size - one bar to the bass,
 * one to the incoming voice - so the part of the blend that comes after the handover grows with the
 * window while the handover itself does not. Past that point the outgoing track has given up its
 * drums, its bass and its voice; what is left of it is residue, and residue does not get better
 * with time. Measured across one session: every blend that sounded right left between 0.1 and 1.1
 * bars behind the handover, and the one that did not left 3.6.
 *
 * Two bars, so no blend that already worked moves by a sample. When the bound does bite it moves
 * the whole gesture later rather than shortening the blend - a long overlap then spends its extra
 * time BEFORE the handover, with the outgoing track still leading and the incoming one rising under
 * it, which is what a long mix is supposed to be.
 */
const MAX_TAIL_BARS = 2;
/** Room left after the last stem move so nothing is still changing as the window ends. */
const TAIL_GUARD_SEC = 0.3;

export interface VocalExit {
    /** Seconds into the window where the outgoing voice starts leaving. */
    from: number;
    /** Seconds into the window where it is gone. */
    to: number;
    /** Which branch fired. Reported so the log can say WHY a transition sounded the way it did. */
    kind: 'rest' | 'recede';
    /** How loud the quietest reachable half-second was, in dB below the window's median. */
    loudDb: number;
}

export interface StemHandover {
    /** Seconds into the window where drums change hands. */
    swap: number;
    /** Where the bass follows, one bar later. Kept apart on purpose - see below. */
    bassAt: number;
    /** Where the incoming voice arrives. */
    vocalIn: number;
    exit: VocalExit;
}

/**
 * Per-cell RMS of one stem over a window.
 *
 * Mono-summed: the question is how loud a stem is, and a voice panned off centre is not quieter.
 */
export const envelopeOf = (
    channels: readonly Float32Array[],
    sampleRate: number,
    cellSec = CELL_SEC,
): Float32Array => {
    const cell = Math.max(1, Math.round(cellSec * sampleRate));
    const length = channels[0]?.length ?? 0;
    const cells = Math.floor(length / cell);
    const out = new Float32Array(cells);
    for (let c = 0; c < cells; c += 1) {
        let sum = 0;
        for (let i = c * cell; i < (c + 1) * cell; i += 1) {
            let frame = 0;
            for (const channel of channels) frame += channel[i];
            sum += (frame / channels.length) ** 2;
        }
        out[c] = Math.sqrt(sum / cell);
    }
    return out;
};

const median = (values: Float32Array | readonly number[]): number => {
    const sorted = [...values].sort((a, b) => a - b);
    if (!sorted.length) return 0;
    const middle = sorted.length >> 1;
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

const db = (ratio: number) => 20 * Math.log10(Math.max(ratio, 1e-12));

/**
 * How the outgoing voice leaves: cut it in a rest, otherwise let it recede.
 *
 * Round eleven's winner, and the ONE arm across eight pairs that the listener never once flagged as
 * swallowing a vocal. It tied on score with "always cut at the quietest half-second" (7.53 each) and
 * won on the annotations, which is the right tiebreak when the gap is under the scoring noise.
 *
 * The search is FREE, not snapped to the beat grid. Snapping was tried because both of round ten's
 * confirmed wins happened to land on a beat; rendered side by side, snapping found a -12 dB moment
 * where the free search found -28 dB on a track whose rest is barely half a second long. Two
 * post-hoc coincidences against one measured 16 dB loss.
 */
export const planVocalExit = (
    /** The outgoing vocal stem's envelope over the window. */
    vocals: Float32Array,
    /** The outgoing mix's envelope over the same window - what "quiet" is measured against. */
    mix: Float32Array,
    /** Last moment the exit may still be running. Past it the incoming voice is established. */
    hardEnd: number,
    /**
     * Where a recede begins. Only used when there is no rest to cut in.
     *
     * Defaulted for the tests that predate it; the gesture derives it - see `planStemHandover`.
     */
    recedeFrom = EXIT_FLOOR_SEC,
    cellSec = CELL_SEC,
): VocalExit => {
    const reference = median(mix);
    const span = Math.max(1, Math.round(CUT_SEC / cellSec));
    // The LOUDEST the voice gets anywhere in the half second, not its average: a cut is only
    // painless if nothing is being cut off, and an average hides a syllable inside a pause.
    const loudAt = (cell: number): number => {
        let peak = 0;
        for (let c = cell; c < cell + span; c += 1) peak = Math.max(peak, vocals[c] ?? 0);
        return db(peak / Math.max(reference, 1e-12));
    };

    // Walked in whole cells rather than by adding `cellSec` to a running total. The accumulating
    // version drifted - after sixty steps it was a few femtoseconds under the cell it named, which
    // is invisible until `Math.round(at / cellSec)` lands one cell early and the search reads a
    // different half second than the one it reports.
    const firstCell = Math.round(EXIT_FLOOR_SEC / cellSec);
    const lastCell = Math.floor((hardEnd - CUT_SEC) / cellSec);
    let best = { cell: firstCell, value: Infinity };
    for (let cell = firstCell; cell <= lastCell; cell += 1) {
        const value = loudAt(cell);
        if (value < best.value) best = { cell, value };
    }
    if (!Number.isFinite(best.value)) best = { cell: firstCell, value: loudAt(firstCell) };
    const at = best.cell * cellSec;

    /**
     * How long the cut takes, graded by how quiet the moment it lands in actually is.
     *
     * REST_DB is a threshold, and everything on the quiet side of it used to be treated as the same
     * thing - a half-second cut at -56 dB, where there is genuinely nothing to cut off, and the
     * same half-second at -31 dB, where there is. The second one is a voice being taken away
     * mid-breath, and it is exactly the "sometimes it leaves too fast, on a few songs" case: rare,
     * because most rests the search finds are deep, and unmissable when it happens.
     *
     * The rule is the same one that justifies cutting at all - a cut is painless only if nothing is
     * being cut off - so its SPEED has to answer the same measurement rather than a constant. Deep
     * silence keeps the half second the listening rounds were scored on; a marginal rest gets up to
     * a second and a bit, which is still a decision and not a drift.
     */
    const softness = Math.min(1, Math.max(0,
        (best.value - DEEP_REST_DB) / (REST_DB - DEEP_REST_DB)));
    const exitSec = CUT_SEC + softness * (SOFT_EXIT_SEC - CUT_SEC);

    return best.value <= REST_DB
        ? { from: at, to: Math.min(at + exitSec, hardEnd), kind: 'rest', loudDb: best.value }
        // Nowhere quiet to hide, so the voice recedes instead. A fade needs somewhere to hide;
        // where there is none, the ear forgives a decision but not a drift.
        : { from: recedeFrom, to: hardEnd, kind: 'recede', loudDb: best.value };
};

/**
 * When each stem changes hands across one window.
 *
 * Drums swap first and near-instantly, bass follows a bar later, and the incoming voice arrives a
 * bar after the drums. Splitting drums from bass is the part that makes this read as a mix rather
 * than a crossfade: two rhythm sections stacked for a bar is muddy, and swapping both at once is a
 * seam. One bar apart, the low end is handed over inside the groove.
 */
export const planStemHandover = (
    windowSec: number,
    /** Bar length of the outgoing track, seconds. Null falls back to a quarter of the window. */
    outgoingBarSec: number | null,
    /** Bar length of the incoming track, seconds. */
    incomingBarSec: number | null,
    /** Downbeats of the outgoing track inside the window, relative to its start. */
    downbeats: readonly number[],
    vocals: Float32Array,
    mix: Float32Array,
    cellSec = CELL_SEC,
): StemHandover => {
    const bar = outgoingBarSec && outgoingBarSec > 0 ? outgoingBarSec : windowSec / 4;
    // The fraction, unless it would leave more than MAX_TAIL_BARS behind the handover - in which
    // case the handover moves back towards the end until it does not. `max`, so this is inert on
    // every window short enough for the fraction to already land late enough.
    const target = Math.max(
        SWAP_TARGET * windowSec,
        windowSec - (1 + MAX_TAIL_BARS) * bar,
    );
    // A bar line if one is in reach, because a handover on the count reads as an edit; the plain
    // fraction otherwise, because a handover somewhere beats no handover.
    const reachable = downbeats.filter(at => at >= 1 && at <= windowSec - 1.5);
    const swap = reachable.length
        ? reachable.reduce((best, at) => (Math.abs(at - target) < Math.abs(best - target) ? at : best))
        : target;
    const bassAt = Math.min(swap + bar, windowSec - TAIL_GUARD_SEC);
    const inBar = incomingBarSec && incomingBarSec > 0 ? incomingBarSec : bar;
    const vocalIn = Math.min(windowSec - 0.6, swap + inBar);
    const hardEnd = Math.min(vocalIn + CUT_SEC, windowSec - 0.4);

    /**
     * Where a recede starts, derived rather than pinned to the floor.
     *
     * It used to begin at EXIT_FLOOR_SEC - a constant whose actual meaning is "earliest a CUT may
     * be placed", borrowed for a question it does not answer. Every other moment here is derived
     * from the music; this one was the only bare number, and it cost the thing it was protecting.
     *
     * Measured on a real window: 7.68s long, incoming voice at 5.83s, the old recede running
     * 0.05-6.33s. By the time the incoming voice arrived the outgoing one was already at **-38 dB**
     * - so the two never overlapped at all, and the "two songs at once" the overlap exists to
     * produce was spent instead on removing a voice nothing was competing with.
     *
     * Which is the first-principles error: the recede serves ONE constraint - do not stack two lead
     * vocals - and that constraint does not exist until `vocalIn`. Before it the outgoing voice is
     * the only voice in the room. `swap` is where it starts instead, because that is the moment the
     * beat changes hands and the listener's attention with it: the outgoing track sings over its
     * own groove until then, and leaves as the incoming one takes the floor. Same window, same
     * deadline, the fade moved to the half of it where it means something.
     *
     * Floored so it stays a fade. Squeezed under a second this reads as a cut, in a place the
     * search has already rejected as too loud to cut in.
     */
    const recedeFrom = Math.max(EXIT_FLOOR_SEC, Math.min(swap, hardEnd - MIN_RECEDE_SEC));

    return { swap, bassAt, vocalIn, exit: planVocalExit(vocals, mix, hardEnd, recedeFrom, cellSec) };
};

/** Equal-power rise from 0 to 1 across [from, to], evaluated at `at`. */
export const rise = (from: number, to: number, at: number): number => {
    if (at <= from) return 0;
    if (at >= to) return 1;
    return Math.sin(((at - from) / (to - from)) * (Math.PI / 2));
};

/**
 * The falling shape, which is deliberately NOT the equal-power complement of `rise`.
 *
 * It is `cos(rise * pi/2)` - the sine curve fed through a second cosine - which is what the harness
 * every listening round was scored from does. The two together dip 1.6 dB at their midpoint rather
 * than holding constant power, and that is not an oversight to correct here: the shape was
 * part of what was heard, the crossings it is used for are six milliseconds long, and changing it
 * would make this a different gesture from the one that was tested.
 */
export const fall = (from: number, to: number, at: number): number =>
    Math.cos(rise(from, to, at) * (Math.PI / 2));

/** Points per second in a scheduled curve. 200 is well inside a millisecond of the ideal shape. */
const CURVE_RATE = 200;

/** Samples a shape into the array setValueCurveAtTime wants. */
export const curveOf = (seconds: number, shape: (at: number) => number): Float32Array => {
    const points = Math.max(2, Math.ceil(seconds * CURVE_RATE));
    const out = new Float32Array(points);
    for (let i = 0; i < points; i += 1) out[i] = shape((i / (points - 1)) * seconds);
    return out;
};

/**
 * How fast a stem changes hands once its moment comes.
 *
 * Six milliseconds - a swap, not a fade. The harness used exactly this and the effect depends on
 * it: a drum kit that fades over half a second is two drum kits for half a second.
 */
const SWAP_EDGE_SEC = 0.006;

/** The gain curve each stem of the outgoing deck follows across the window. */
export const outgoingCurves = (
    windowSec: number,
    plan: StemHandover,
): Record<StemName, Float32Array> => ({
    vocals: curveOf(windowSec, at => fall(plan.exit.from, plan.exit.to, at)),
    drums: curveOf(windowSec, at => fall(plan.swap, plan.swap + SWAP_EDGE_SEC, at)),
    bass: curveOf(windowSec, at => fall(plan.bassAt, plan.bassAt + SWAP_EDGE_SEC, at)),
    // The pad and guitar bed is the one stem that neither swaps nor cuts: it is thinned from below
    // as it goes, so what is left of the outgoing track under the incoming one is air rather than
    // body. The filter sweep that does the thinning is scheduled separately.
    other: curveOf(windowSec, at => fall(windowSec * 0.92, windowSec, at)),
});

/** And the incoming deck's. Deliberately not the mirror image - see planStemHandover. */
export const incomingCurves = (
    windowSec: number,
    plan: StemHandover,
): Record<StemName, Float32Array> => ({
    vocals: curveOf(windowSec, at => rise(plan.vocalIn, plan.vocalIn + CUT_SEC, at)),
    drums: curveOf(windowSec, at => rise(plan.swap, plan.swap + SWAP_EDGE_SEC, at)),
    bass: curveOf(windowSec, at => rise(plan.bassAt, plan.bassAt + SWAP_EDGE_SEC, at)),
    // Arrives BEFORE its own drums, so the incoming track is already present as atmosphere when the
    // beat changes hands. Round ten measured this the hard way: on the one pair where the incoming
    // track was made to crash in with its drums it scored 3.0, against 7.0 for entering quietly.
    other: curveOf(windowSec, at => rise(Math.max(0, plan.swap - 1.2), plan.swap, at)),
});

/** Where the outgoing `other` stem's high-pass starts and ends, in Hz. */
export const OTHER_SWEEP_HZ: readonly [number, number] = [25, 2200];
/** The fraction of the window the sweep runs over. Ends before the stem's own fade does. */
export const OTHER_SWEEP_END = 0.92;

