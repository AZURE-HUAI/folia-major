import { describe, expect, it } from 'vitest';
import {
    alignEntry,
    barGrid,
    quantiseToMusic,
    settledBpm,
    snapToGrid,
    tempoMatch,
    BEATS_PER_PHRASE,
} from '@/services/automix/musicalTime';

// test/unit/automix/musicalTime.test.ts
// The units music is counted in, and the one relationship between two tracks that a gain curve
// cannot stand in for.

describe('settledBpm', () => {
    it('prefers the tail, which is the half a transition is laid against', () => {
        expect(settledBpm(120, 118)).toBe(118);
    });

    it('answers null when the two readings of one track disagree', () => {
        // Not "take the later one". Two measurements of one quantity that disagree by a third mean
        // the quantity was not measured - no song slows by a third into its last chorus, that is a
        // beat tracker on the wrong harmonic. Both of these are verbatim from a real log.
        expect(settledBpm(92, 123)).toBe(null);
        expect(settledBpm(136, 86)).toBe(null);
        expect(settledBpm(117, 136)).toBe(null);
    });

    it('still folds the octave, because that disagreement is not one', () => {
        // 88 against 176 is the same pulse counted twice, and the tail reading is usable.
        expect(settledBpm(88, 176)).toBe(176);
    });

    it('falls back rather than inventing, when only one end was measured', () => {
        expect(settledBpm(120, null)).toBe(120);
        expect(settledBpm(null, 120)).toBe(120);
        expect(settledBpm(null, null)).toBe(null);
        expect(settledBpm(0, 0)).toBe(null);
    });
});

describe('tempoMatch', () => {
    it('treats half time and double time as the same tempo', () => {
        // 90 against 180 is not a doubling of speed, it is one pulse counted two ways. Forcing
        // either onto the other would be a two-to-one stretch to fix something nobody can hear.
        expect(tempoMatch(90, 180).relation).toBe('locked');
        expect(tempoMatch(180, 90).relation).toBe('locked');
        expect(tempoMatch(60, 120).stretch).toBe(1);
    });

    it('grades a difference by what could honestly be done about it', () => {
        expect(tempoMatch(120, 120.5).relation).toBe('locked');
        expect(tempoMatch(120, 125).relation).toBe('near');
        expect(tempoMatch(120, 128).relation).toBe('stretchable');
        // Past a turntable's pitch fader, which is where a record stops sounding like itself.
        expect(tempoMatch(120, 138).relation).toBe('far');
    });

    it('refuses the ratios a mis-measured tempo produces', () => {
        // The reason the limit is 8% and not 25%. A beat tracker that locks onto the wrong harmonic
        // returns 5:4, 4:3 or 3:2 of the true period, so those exact ratios are far more often a
        // measurement error than a real pair of tempos - and bending to meet one is maximum damage
        // for no benefit. Every one of these appeared in a real log.
        expect(tempoMatch(123, 92).relation).toBe('far');   // 3:4, logged as "92 BPM (123 at the end)"
        expect(tempoMatch(136, 102).relation).toBe('far');  // 3:4 again
        expect(tempoMatch(117, 89).relation).toBe('far');   // 4:3
        expect(tempoMatch(123, 92).stretch).toBe(1);
    });

    it('bends the outgoing track onto the incoming one, never the other way', () => {
        // The departing track has seconds left and no future to be wrong in; the arriving one is
        // about to be listened to for three minutes.
        const match = tempoMatch(100, 105);
        expect(match.stretch).toBeCloseTo(1.05, 6);
        expect(match.ratio).toBeCloseTo(1.05, 6);
    });

    it('does nothing at all when the two are too far apart', () => {
        // `far` routes to a different transition, not to a bigger correction.
        expect(tempoMatch(90, 128).stretch).toBe(1);
    });

    it('has no answer without two tempos', () => {
        expect(tempoMatch(null, 120)).toMatchObject({ relation: 'unknown', stretch: 1 });
        expect(tempoMatch(120, 0)).toMatchObject({ relation: 'unknown', stretch: 1 });
    });
});

describe('quantiseToMusic', () => {
    const beat = 0.5;

    it('rounds a long blend to whole phrases', () => {
        // Four bars is what an arrangement is built in; 4.8 beats is not a length any music has.
        expect(quantiseToMusic(9, beat, 30)).toBeCloseTo(BEATS_PER_PHRASE * beat, 6);
    });

    it('rounds a middling blend to whole bars and a short one to whole beats', () => {
        expect(quantiseToMusic(2.6, beat, 30)).toBeCloseTo(4 * beat, 6);
        expect(quantiseToMusic(1.1, beat, 30)).toBeCloseTo(2 * beat, 6);
    });

    it('steps down by whole units rather than landing on the ceiling', () => {
        // The ceiling is a limit, not a length. Twenty-five seconds is not a number of bars.
        const answer = quantiseToMusic(16, beat, 6.2);
        expect(answer).toBeLessThanOrEqual(6.2);
        expect(answer / beat).toBe(Math.round(answer / beat));
        expect(answer).toBeCloseTo(12 * beat, 6);
    });

    it('never returns nothing, however tight the ceiling', () => {
        expect(quantiseToMusic(8, beat, 0.1)).toBeCloseTo(beat, 6);
    });

    it('passes the seconds straight through without a grid to count on', () => {
        expect(quantiseToMusic(4, null, 30)).toBe(4);
        expect(quantiseToMusic(40, null, 30)).toBe(30);
    });
});

describe('barGrid and snapToGrid', () => {
    it('folds the downbeat into the first bar', () => {
        // 120 BPM: a bar is two seconds, so a downbeat at 7.5s is the same grid as one at 1.5s.
        expect(barGrid(120, 7.5)).toEqual({ offset: 1.5, period: 2 });
    });

    it('has no grid without a tempo or without a downbeat', () => {
        expect(barGrid(null, 1.5)).toBeNull();
        expect(barGrid(120, null)).toBeNull();
    });

    it('moves a moment onto a line only when one is close enough to reach', () => {
        const grid = { offset: 1.5, period: 2 };
        expect(snapToGrid(9.8, grid, 0.5)).toBeCloseTo(9.5, 6);
        // A whole bar away is a different handover, not the same one tidied up.
        expect(snapToGrid(10.4, grid, 0.5)).toBe(10.4);
        expect(snapToGrid(9.8, null, 0.5)).toBe(9.8);
    });
});

describe('alignEntry', () => {
    it('starts the incoming track so its bar line lands on the outgoing one\'s', () => {
        // The half of beat matching a gain curve genuinely cannot do: two tracks whose bars are a
        // quarter note apart stay a quarter note apart however the levels are moved.
        const incoming = { offset: 0.4, period: 2 };
        // The outgoing track's next bar line is 1.2s after the handover, so the incoming track has
        // to be 1.2s short of one of its own when it starts.
        const entry = alignEntry(1, incoming, 1.2);
        expect((entry + 1.2 - incoming.offset) % incoming.period).toBeCloseTo(0, 6);
        expect(entry).toBeGreaterThanOrEqual(1);
    });

    it('never enters before the point everything else agreed on', () => {
        // Skipping into a track to make the bars agree would delete the beginning of it.
        for (const phase of [0, 0.3, 0.9, 1.7, 1.99]) {
            expect(alignEntry(2.5, { offset: 0.4, period: 2 }, phase)).toBeGreaterThanOrEqual(2.5);
        }
    });

    it('leaves the entry alone when either side has no grid', () => {
        expect(alignEntry(1.5, null, 0.5)).toBe(1.5);
        expect(alignEntry(1.5, { offset: 0, period: 2 }, null)).toBe(1.5);
    });
});
