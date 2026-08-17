import { BEATS_PER_BAR } from './signalAnalysis';

// src/services/automix/musicalTime.ts
// The units music is actually built in - beats, bars, phrases - and the one relationship between
// two tracks that a gain curve can never stand in for: how fast each of them is running.
//
// Everything here is arithmetic on numbers. It sits between the evidence layer, which measures
// tempo, and the two decision files, which both need to reason in bars rather than seconds.

/** A phrase: four bars of four. The span nearly all pop and dance music is written in. */
export const BEATS_PER_PHRASE = BEATS_PER_BAR * 4;

/**
 * How two tempos sit together, in the four grades that lead to four different actions.
 *
 * - `locked`     the two are already the same speed to within a rounding error
 * - `near`       close enough that pulling one onto the other is under a semitone of pitch
 * - `stretchable` far enough apart to hear, close enough to fix without the fix being the problem
 * - `far`        past what stretching can hide; the answer is a different transition, not a rate
 */
export type TempoRelation = 'locked' | 'near' | 'stretchable' | 'far' | 'unknown';

/** Inside this the two tempos are the same number measured twice. */
const LOCKED_DEVIATION = 0.015;
/**
 * Small enough that the stretch is doing no work worth hearing about, either way.
 *
 * A semitone is 5.946%, and this used to be that number on the grounds that under a semitone the
 * pitch error is inaudible. Pitch is no longer moving at all - the element preserves it - so what
 * the boundary now separates is how long the pair may be held together, not whether a correction is
 * needed.
 */
export const RAW_RATE_LIMIT = 0.0594;
/**
 * Past this the two tracks are not at nearly the same tempo, and forcing them makes it worse.
 *
 * Eight percent is where a turntable's pitch fader stops, and that is not an arbitrary piece of
 * hardware trivia: it is the widest a record can be pulled before the room hears it as a different
 * record rather than the same one, arrived at over decades of people doing exactly this in front of
 * an audience. A stretcher moves the artefact from pitch to texture but does not raise that limit.
 *
 * The number this replaces was 0.25, and it was wrong twice. Loud: at a quarter, a fifth of every
 * window a stretcher emits is invented rather than played. Quiet, and worse: 0.25 is 5:4 and 0.33
 * is 4:3, which are exactly the ratios an autocorrelation returns when it locks onto the wrong
 * harmonic of the beat. So the widest bends were not the pairs that most needed matching - they
 * were disproportionately the pairs where one of the two tempos had been measured wrong, and the
 * bend was maximum damage for no benefit at all. Below 8% no harmonic error can reach, so what is
 * left in the band is real.
 */
const STRETCH_LIMIT = 0.08;

export interface TempoMatch {
    relation: TempoRelation;
    /**
     * Rate the OUTGOING deck should run at to meet the incoming one. 1 when nothing is to be done.
     *
     * The outgoing track is the one that gets bent, and that is a deliberate inversion of what a DJ
     * does. A DJ must not disturb the record the room is already dancing to, so they pitch the
     * arriving one. Here the departing track has seconds left and no future to be wrong in, while
     * the arriving one is about to be listened to for three minutes - so anything done to it would
     * have to be walked back afterwards, and walking a tempo back under a track that is now alone is
     * the one moment in a transition with nothing to hide behind.
     */
    stretch: number;
    /** Octave-folded incoming/outgoing, for the log. 1.0 when either tempo is unknown. */
    ratio: number;
}

/**
 * Half time and double time are the same tempo.
 *
 * 90 against 180 is not a 100% difference, it is the same pulse counted two ways, and forcing
 * either onto the other would be a two-to-one time stretch to fix a difference nobody can hear.
 * Folding into a factor of root two either side of unity is the standard resolution.
 */
const foldRatio = (ratio: number): number => {
    let folded = ratio;
    while (folded > Math.SQRT2) folded /= 2;
    while (folded < 1 / Math.SQRT2) folded *= 2;
    return folded;
};

export const tempoMatch = (
    fromBpm: number | null | undefined,
    toBpm: number | null | undefined,
): TempoMatch => {
    if (!fromBpm || !toBpm || !(fromBpm > 0) || !(toBpm > 0)) {
        return { relation: 'unknown', stretch: 1, ratio: 1 };
    }
    const ratio = foldRatio(toBpm / fromBpm);
    const deviation = Math.abs(ratio - 1);
    if (deviation < LOCKED_DEVIATION) return { relation: 'locked', stretch: 1, ratio };
    if (deviation <= RAW_RATE_LIMIT) return { relation: 'near', stretch: ratio, ratio };
    if (deviation <= STRETCH_LIMIT) return { relation: 'stretchable', stretch: ratio, ratio };
    return { relation: 'far', stretch: 1, ratio };
};

/**
 * The tempo of a track's END, or null when its two measurements do not agree about it.
 *
 * A track is measured twice - once whole, once over its last half minute - and the second is
 * preferred, because a song that slows into its final chorus has two tempos and only one of them is
 * the one a transition is laid against. That preference is right and it was being applied without
 * the check that makes it safe.
 *
 * Two measurements of one quantity that disagree do not mean the later one is correct. They mean
 * the quantity was not measured. Real logs carry "92 BPM, 123 at the end" and "136 BPM, 86 at the
 * end" - a third and a half apart, which no song does; those are the beat tracker locking onto a
 * 3:2 or a 4:3 of the true period in one window and not the other. Taking the tail number on faith
 * then bends a track by a third to meet a tempo that was never there.
 *
 * So: agree within a real tempo drift and the tail wins, as it should. Disagree past that and the
 * answer is null - which routes to the live tap for a grid, and to no bend at all, both of which
 * are what "we do not know this track's tempo" should do.
 */
export const settledBpm = (
    whole: number | null | undefined,
    outro: number | null | undefined,
): number | null => {
    const wholeOk = whole && whole > 0 ? whole : null;
    const outroOk = outro && outro > 0 ? outro : null;
    if (!outroOk) return wholeOk;
    if (!wholeOk) return outroOk;
    return Math.abs(foldRatio(outroOk / wholeOk) - 1) <= RAW_RATE_LIMIT ? outroOk : null;
};

/**
 * How much longer or shorter an overlap wants to be, given how the two tempos sit.
 *
 * Two tracks running at one tempo can be held against each other for a long time - that is what a
 * DJ mix is. Two that are drifting apart cannot: every second of overlap is another fraction of a
 * beat out, so the honest answer to a big difference is less of it.
 */
export const TEMPO_LENGTH_SCALE: Record<TempoRelation, number> = {
    locked: 1.3,
    near: 1.2,
    stretchable: 1.1,
    far: 0.5,
    unknown: 1,
};

/**
 * Rounds a length to something music is counted in, largest unit that fits.
 *
 * A blend is a musical span, and the spans music has are the phrase, the bar and the beat - in that
 * order of preference, because a four-bar blend lands where the arrangement lands and a 4.8-beat one
 * lands nowhere. Falls back to the raw seconds without a tempo, which is the honest answer when
 * there is no grid to count on.
 */
export const quantiseToMusic = (
    seconds: number,
    beatSec: number | null,
    maxSeconds: number,
): number => {
    if (beatSec === null || !(beatSec > 0)) return Math.min(seconds, maxSeconds);

    const unitFor = (beats: number) => (
        beats >= BEATS_PER_PHRASE ? BEATS_PER_PHRASE : beats >= BEATS_PER_BAR ? BEATS_PER_BAR : 1
    );
    const wanted = seconds / beatSec;
    let unit = unitFor(wanted);
    let beats = Math.round(wanted / unit) * unit;

    // Stepping down rather than clamping: a phrase-length blend trimmed to a ceiling should come
    // out as a shorter whole number of phrases, not as the ceiling itself.
    while (beats * beatSec > maxSeconds && beats > 1) {
        const next = unitFor(beats - unit);
        if (next < unit) unit = next;
        beats = Math.max(1, beats - unit);
    }
    return Math.max(1, beats) * beatSec;
};

export interface Grid {
    /** Seconds from the start of the track to a line of this grid. */
    offset: number;
    /** Seconds between lines. */
    period: number;
}

/** The bar grid of a track, from its beat grid and where its downbeat falls. */
export const barGrid = (
    bpm: number | null | undefined,
    downbeatOffset: number | null | undefined,
    beatsPerBar = BEATS_PER_BAR,
): Grid | null => {
    if (!bpm || !(bpm > 0) || downbeatOffset === null || downbeatOffset === undefined) return null;
    const period = (60 / bpm) * beatsPerBar;
    return { offset: ((downbeatOffset % period) + period) % period, period };
};

/**
 * Moves a moment onto the nearest line of a grid, if there is one close enough to move it to.
 *
 * Tolerance rather than unconditional snapping, and it matters in both directions: a handover
 * dragged half a bar to reach a bar line is no longer the handover that was planned, and one left a
 * twentieth of a beat off a bar line is on it as far as anyone can hear. Returns the input
 * unchanged when there is no grid, which is what "we could not tell where the bars are" should do.
 */
export const snapToGrid = (
    seconds: number,
    grid: Grid | null,
    toleranceSec: number,
): number => {
    if (!grid || !(grid.period > 0) || !(toleranceSec > 0)) return seconds;
    const line = grid.offset + Math.round((seconds - grid.offset) / grid.period) * grid.period;
    return Math.abs(line - seconds) <= toleranceSec && line > 0 ? line : seconds;
};

/**
 * Where the incoming track has to be started from for its bars to line up with the outgoing one's.
 *
 * This is the half of beat matching that a gain curve genuinely cannot do. Two tracks at the same
 * tempo whose bars are a quarter note apart stay a quarter note apart for the whole overlap, however
 * the levels are moved: the only lever is where the second one is started from, and a media element
 * can be seeked. So the entry point is walked forward to whichever bar line of the incoming track
 * puts its downbeat on the outgoing track's downbeat.
 *
 * `earliest` is the entry point everything else already agreed on - past the leading silence, at the
 * planned start - and the answer is never before it: skipping into a track to make the bars agree
 * would delete the beginning of it.
 */
export const alignEntry = (
    earliest: number,
    incoming: Grid | null,
    /** Seconds from the handover to the outgoing track's next bar line. */
    outgoingBarPhase: number | null,
): number => {
    if (!incoming || outgoingBarPhase === null || !(incoming.period > 0)) return earliest;
    // Where the incoming track would have to be so that its own next bar line falls at the same
    // moment as the outgoing track's.
    const barsIn = Math.ceil((earliest - incoming.offset) / incoming.period);
    const line = incoming.offset + Math.max(0, barsIn) * incoming.period;
    const entry = line - outgoingBarPhase;
    return entry >= earliest ? entry : entry + incoming.period;
};
