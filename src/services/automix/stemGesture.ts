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
 * Shortest a note has to be held before it counts as held rather than merely sung.
 *
 * 1.2 seconds. Under it this is a long syllable, and a long syllable is part of a phrase - the
 * phrase is what the rest search is already good at finding the end of. Over it the voice has
 * stopped delivering words and is doing the one thing a fade cannot hide behind.
 */
const SUSTAIN_MIN_SEC = 1.2;
/**
 * How far a held note may wander from its own peak and still be the same note.
 *
 * Seven dB. Vibrato and a natural swell live well inside this; a syllable boundary does not, which
 * is what keeps an ordinary sung phrase from reading as a sustain. The note ENDS where it leaves
 * the band, and that moment is the singer letting go - the one place an exit costs nothing.
 */
const SUSTAIN_FLAT_DB = 7;


/**
 * How long a run of cells has to stay up before it counts as singing.
 *
 * A quarter second. Separation leaks - a snare tail or a cymbal lands in the vocal stem as a
 * transient a cell or two long - and one loud cell is exactly what that looks like. A sung syllable
 * is longer than this; a leaked hit is not.
 */
const SUSTAIN_CELLS = 5;

/**
 * How much past the last sounding cell the voice is called finished.
 *
 * A held note falls under the threshold while it is still decaying, so the cell that fails the test
 * is not the end of the note. Three tenths, and the DIRECTION is the whole point: every error this
 * function can make has to land late. A vocal end reported late puts a handover in the instrumental
 * outro, which is dull; one reported early puts it on top of a singer, which is the defect.
 */
const VOCAL_TAIL_SEC = 0.3;

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
    kind: 'rest' | 'recede' | 'release';
    /** How loud the quietest reachable half-second was, in dB below the window's median. */
    loudDb: number;
    /**
     * The held note the voice is on as it leaves, if it is on one. Null when it is not.
     *
     * Reported whether or not it changed the exit, because it is the measurement this branch was
     * chosen against and the only way to find out whether the detector sees what a listener hears.
     */
    held: VocalSustain | null;
}

/**
 * A note the outgoing voice is holding: where it starts, where it lets go, how loud it sits.
 *
 * The object this exists to name is the one the exit search cannot see. `planVocalExit` looks for
 * the QUIETEST half-second - a rest to cut in - and when it finds none it falls back to fading
 * across whatever is there. A sustained note is the worst possible thing to fade across: nothing
 * about it changes, so the only thing moving is the fader, and a fader on a held note is the one
 * gesture an ear reads as an edit rather than as music. It is also, held against a compatible
 * sustain on the other side, the most beautiful handover there is - which is the same fact.
 */
export interface VocalSustain {
    /** Seconds into the window where the note is first held. */
    from: number;
    /** Where it lets go - the first moment it has fallen out of its own band. */
    to: number;
    /** How far the note sits above the mix's median level, in dB. */
    holdDb: number;
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
 * The last note the outgoing voice HOLDS inside the window, or null if it never holds one.
 *
 * Walked forward and kept rather than returned early, because the last one is the one an exit has
 * to deal with. A run opens when the voice comes above the singing floor, tracks its own peak, and
 * closes the moment the level falls more than SUSTAIN_FLAT_DB under that peak - which for a held
 * note is the singer letting go, and for a sung phrase is the gap after a syllable. Only runs that
 * lasted SUSTAIN_MIN_SEC survive, so the second case falls out on its own.
 *
 * The peak is tracked rather than fixed at the run's first cell so a note that swells stays one
 * note. It only ever rises, which is what makes the band asymmetric on purpose: a note may grow
 * without limit and is finished the moment it decays past the band. That IS the release.
 */
export const findSustain = (
    /** The outgoing vocal stem's envelope over the window. */
    vocals: Float32Array,
    /** The outgoing mix's envelope over the same window. */
    mix: Float32Array,
    cellSec = CELL_SEC,
): VocalSustain | null => {
    const reference = Math.max(median(mix), 1e-12);
    const floor = reference * 10 ** (REST_DB / 20);
    const band = 10 ** (-SUSTAIN_FLAT_DB / 20);
    const need = Math.max(1, Math.round(SUSTAIN_MIN_SEC / cellSec));

    let held: VocalSustain | null = null;
    let start = -1;
    let peak = 0;
    // One past the end, so a note still ringing as the window closes is closed by the loop rather
    // than dropped - that case is the whole point and it is the one an early exit would lose.
    for (let cell = 0; cell <= vocals.length; cell += 1) {
        const level = cell < vocals.length ? vocals[cell] : 0;
        if (start >= 0 && level > floor && level >= peak * band) {
            if (level > peak) peak = level;
            continue;
        }
        if (start >= 0 && cell - start >= need) {
            held = {
                from: start * cellSec,
                to: cell * cellSec,
                holdDb: db(peak / reference),
            };
        }
        start = level > floor ? cell : -1;
        peak = level;
    }
    return held;
};

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
    /**
     * Whether a held note may be ridden out over the incoming track at all.
     *
     * False only when the two keys are KNOWN to clash - a semitone or a tritone apart, the two
     * intervals `keyRelation` singles out as the most dissonant thing two mixes can do at once. A
     * held vowel is a sustained PITCH, and this is the one gesture here that puts a bare interval
     * in front of the listener for seconds at a time. A semitone against the incoming harmony
     * beats audibly and there is no fader shape that hides it.
     *
     * Only 'clashing', not "anything short of compatible". Two of four transitions in one real
     * session came back 'unknown' - the key estimate declines below its own confidence floor far
     * more often than it finds a clash - and what a refusal falls back to is a fade across the
     * middle of a held note, which is the defect this branch exists to remove. So the test is for
     * evidence AGAINST, never for evidence in favour, which is the same rule `LENGTH_SCALE`
     * already applies when it scores an unknown key exactly as high as a compatible one.
     */
    mayRide = true,
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
    //
    // From `recedeFrom`, and this bound is the difference between a cut and a swallowed vocal.
    // Both branches answer ONE question - when may the outgoing voice leave - and they were
    // answering it with two different numbers: the recede began at `recedeFrom`, the cut began
    // wherever the quietest half-second happened to fall, anywhere in the window. Quietest is not a
    // placement rule, and on a long window it is barely even correlated with one.
    //
    // Measured: a 23.5s blend found a genuine -35 dB rest at 5.35s and ended the vocal at 6.33s.
    // The incoming voice was not due until 20.15s, and the sustain detector on the same line
    // reported the outgoing singer still holding a note at 21.70s. Nearly fourteen seconds of two
    // songs playing at once with neither one singing - which is the defect as the listener
    // describes it, and note that it reads as BOTH tracks losing their vocal, because it is one
    // hole rather than two edits.
    //
    // Nothing is given up by starting late. If the voice has genuinely finished early then every
    // later half-second is at least as quiet and the same painless cut is still there to find. The
    // only case the bound removes is the one where an early moment beat a late one BECAUSE the
    // singing resumed after it - and losing that case is the entire point.
    const firstCell = Math.round(recedeFrom / cellSec);
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

    // Measured on every exit, used on none of them yet, and reported on all of them. The branch it
    // would justify - ride the note's own release instead of imposing a fade across it - changes
    // what a transition sounds like, and three changes have already gone in today without an ear on
    // any of them. So this ships as an instrument first: one listening pass says whether it sees
    // what the listener hears, and the behaviour follows from that rather than from this comment.
    const held = findSustain(vocals, mix, cellSec);

    /**
     * A note still sounding at the deadline is ridden to its release instead of faded across.
     *
     * This branch outranks the other two, and it has to: both of them end the voice somewhere
     * inside the note. The rest search would cut in a quiet moment BEFORE it and take the whole
     * note away; the recede would fade down the middle of it, which is the one gesture an ear reads
     * as a fader rather than as music - on a held note nothing else is changing, so the fader is
     * the only thing moving and it is plainly audible.
     *
     * The release is where an exit costs nothing, so the exit goes there. What it buys is bounded
     * and knowable: the note keeps sounding past `hardEnd`, over the incoming voice, until the
     * singer lets go. That is a deliberate breach of the do-not-stack-two-voices rule, and it is
     * narrower than it sounds - the rule exists because two voices DELIVERING WORDS turn to mud,
     * and a held vowel is not delivering words. It is the case a DJ reaches for on purpose.
     *
     * Measured on the window this was built from: a 10.60s note released at 13.45s in a 14.4s
     * blend, with the fade starting at 0.83s - two seconds before the note it was fading even
     * began. The listener's report on that transition was that the voice left too early and would
     * otherwise have met the incoming track's own held note exactly.
     *
     * Three conditions, and the third is the one that keeps this honest. The note has to be
     * sounding at the deadline (`from <= hardEnd < to`), or it is not the note the exit collides
     * with - `findSustain` reports the LAST hold in the window, which on some tracks is one the
     * voice takes up again well after it was due to leave. And it has to RELEASE inside the window:
     * a note still going when the blend ends has no release to ride to, and riding it anyway would
     * mean never letting go at all, just handing the decision to the moment the deck stops. One
     * cell of margin, because `findSustain` closes an unreleased note exactly at the window's end -
     * the same test the `still holding when the window ends` log line makes.
     *
     * What it does NOT ask for is room to do a full half-second cut afterwards, and that bound cost
     * the very transition this branch was written for. The note there released at 13.45s in a
     * 13.62s window: a singer finishing her last held note as the blend runs out. That is not an
     * edge case, it is the commonest shape there is, because the window is PLACED against where she
     * stops singing - so the last note in it will nearly always be the one that ends near its end.
     * Demanding CUT_SEC + TAIL_GUARD_SEC behind the release refused the ride and sent it back to a
     * recede starting at 5.37s, which is the report that this fade left one to two seconds early.
     * The cut is clamped to the window instead: a release with a tenth of a second behind it gets a
     * tenth of a second of fade, and that is a fade on a note which has already let go and has
     * nothing left to take away.
     */
    const windowSec = vocals.length * cellSec;
    const ridable = mayRide
        && held !== null
        && held.from <= hardEnd
        && held.to > hardEnd
        && held.to <= windowSec - cellSec;
    if (ridable && held) {
        return {
            from: held.to,
            to: Math.min(held.to + CUT_SEC, windowSec),
            kind: 'release',
            loudDb: best.value,
            held,
        };
    }

    return best.value <= REST_DB
        ? { from: at, to: Math.min(at + exitSec, hardEnd), kind: 'rest', loudDb: best.value, held }
        // Nowhere quiet to hide, so the voice recedes instead. A fade needs somewhere to hide;
        // where there is none, the ear forgives a decision but not a drift.
        : { from: recedeFrom, to: hardEnd, kind: 'recede', loudDb: best.value, held };
};

/**
 * The last moment the outgoing track is still singing, in seconds from the window's start.
 *
 * Null when it never sings inside the window at all, which is the honest answer rather than zero:
 * "the singing stopped before this window began" is a bound, not a time, and the caller has a
 * better one.
 *
 * This exists because the planner has been asking a LYRIC FILE where a track stops singing. Plain
 * LRC has no end times at all, so the parser invents one - the last line's start plus a flat five
 * seconds - and that number is then the floor under every handover placement. It is not a
 * measurement of anything; a singer who holds past it gets a transition opened on top of her.
 *
 * Same threshold as the exit search, against the same reference, for the same reason: quiet only
 * means anything measured against what else is playing, and a voice thirty dB under the mix it sits
 * in has stopped being one of the things in the room whether or not it is still technically
 * sounding.
 */
export const lastVocalMoment = (
    /** The vocal stem's envelope over the window. */
    vocals: Float32Array,
    /** The mix's envelope over the same window. */
    mix: Float32Array,
    cellSec = CELL_SEC,
): number | null => {
    const floor = median(mix) * 10 ** (REST_DB / 20);
    // Walked backwards, so the first qualifying run found is the LAST one in the window. `edge` is
    // its right-hand end - the cell the run was entered on - because that is the moment being
    // reported, not the point a quarter second earlier where the evidence became sufficient.
    let run = 0;
    let edge = -1;
    for (let cell = vocals.length - 1; cell >= 0; cell -= 1) {
        if (vocals[cell] <= floor) {
            run = 0;
            continue;
        }
        if (run === 0) edge = cell;
        run += 1;
        if (run >= SUSTAIN_CELLS) return (edge + 1) * cellSec + VOCAL_TAIL_SEC;
    }
    return null;
};

/**
 * The first moment the INCOMING track sings, in seconds from the window's start.
 *
 * The twin of `lastVocalMoment`, and deliberately not its exact mirror, because the error each one
 * has to keep on the safe side points the opposite way. A vocal END reported late puts a handover
 * in a dull instrumental outro and reported early puts it on top of a singer, so that one rounds
 * up and adds a tail. An ENTRY reported early only raises a fader on a stem that is still silent,
 * which costs nothing; reported late it mutes real singing. So this returns the first cell of the
 * run rather than the cell the evidence became sufficient on, and adds nothing to it.
 *
 * Null when the incoming track never sings inside the window, which for a long intro is the
 * ordinary answer rather than a failure - the caller keeps its own guess for that case.
 */
export const firstVocalMoment = (
    /** The incoming vocal stem's envelope over the window. */
    vocals: Float32Array,
    /** The incoming mix's envelope over the same window - the same relative floor, its own track. */
    mix: Float32Array,
    cellSec = CELL_SEC,
): number | null => {
    const floor = median(mix) * 10 ** (REST_DB / 20);
    let run = 0;
    let edge = -1;
    for (let cell = 0; cell < vocals.length; cell += 1) {
        if (vocals[cell] <= floor) {
            run = 0;
            continue;
        }
        if (run === 0) edge = cell;
        run += 1;
        if (run >= SUSTAIN_CELLS) return edge * cellSec;
    }
    return null;
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
    /** What the incoming track's own stems say about it. Empty means nothing was measured. */
    incoming: {
        /**
         * Where the incoming voice actually starts singing, seconds into the window, off its own
         * vocal stem. Null or absent when it does not sing inside the window at all.
         */
        vocalAt?: number | null;
        /** The two keys are known to clash. See `planVocalExit`'s `mayRide`. */
        keysClash?: boolean;
    } = {},
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
    /**
     * Where the incoming voice arrives - measured off its own vocal stem when it can be, guessed
     * only when it cannot.
     *
     * It used to be `swap + inBar` always: one bar after the drums change hands. That is the
     * choreography the listening rounds settled, and it is a statement about the GESTURE, not about
     * the song - the incoming track sings when it sings. And `vocalIn` is not only the deadline the
     * outgoing voice has to be gone by; it is also the moment THIS deck's vocal fader comes up.
     *
     * Measured on a real pair: the guess said 10.20s and the singer came in at about 7.13s, so
     * three seconds of real singing were held at zero while the outgoing voice was still receding
     * over the top of it. The listener's report was that by the time the mix reached the next track
     * several lines had already gone by, which is exactly what that sounds like from outside - the
     * lyrics scroll on the incoming track's own clock while its voice is muted.
     *
     * Used only when it lands AFTER the swap, and this bound is not a safety margin, it is the
     * difference between a constraint and an impossibility. A track already singing as the window
     * opens - measured at 1.84s into a 24s blend on one real pair - cannot be honoured by either
     * job this number does. As a deadline it would ask the outgoing voice to be gone before the
     * beat has even changed hands, which is the swallowed-vocal defect reached from the other side;
     * as a fader time it would put two lead vocals side by side for seventeen seconds, which is the
     * rule that made the whole gesture split its stems in the first place. When a constraint cannot
     * be met, the choreography stands: it is what eleven listening rounds settled and it is a
     * defensible answer, where anything clamped out of an unusable measurement is arbitrary.
     *
     * So the measurement moves this only where it can actually be obeyed, and every window whose
     * incoming track sings after the handover - or does not sing inside the window at all - comes
     * out bit-identical to what it was. That is deliberate: the listener called three of the four
     * transitions in the session this was measured on fine, and only one of them was guessed wrong
     * in a direction anything could be done about.
     */
    const vocalIn = Math.min(
        windowSec - 0.6,
        incoming.vocalAt != null && incoming.vocalAt >= swap ? incoming.vocalAt : swap + inBar,
    );
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
     *
     * And floored ONLY there. A second floor of two bars was tried, to answer a listener's report
     * that the voice left too quickly - and it made the complaint worse on every window it touched,
     * because a longer fade here is not a slower one. The END is pinned at `hardEnd`, and `fall`
     * crosses audibility at 74.3% of whatever span it is given, so stretching the span backwards
     * moves the moment the voice DISAPPEARS earlier. Measured on the three windows the report came
     * from: the silence between the outgoing voice going inaudible and the incoming one arriving
     * went 0.18 -> 1.40s, 0.14 -> 0.45s and 0.12 -> 0.53s. Rate and start are not independent while
     * the deadline is fixed; making this fade genuinely slower means moving `hardEnd`, which is a
     * different constraint and belongs to the branch below.
     */
    const recedeFrom = Math.max(EXIT_FLOOR_SEC, Math.min(swap, hardEnd - MIN_RECEDE_SEC));

    return {
        swap,
        bassAt,
        vocalIn,
        exit: planVocalExit(vocals, mix, hardEnd, recedeFrom, cellSec, !incoming.keysClash),
    };
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

