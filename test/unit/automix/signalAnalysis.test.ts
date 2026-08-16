import { describe, expect, it } from 'vitest';
import {
    buildCrossfadeCurves,
    crossoverFor,
    estimateTempo,
    planBlendShape,
    rmsDb,
    spectralFlux,
    trimForBalance,
    CROSSOVER_EARLY,
    CROSSOVER_LATE,
    MAX_TRIM_DB,
    MIN_TEMPO_CONFIDENCE,
    SILENCE_DB,
} from '@/services/automix/signalAnalysis';

// test/unit/automix/signalAnalysis.test.ts
// The measurement half of automix. Everything here decides how a blend sounds, and none of it is
// observable from the outside without ears, so the maths is pinned down against known signals.

const HOP = 0.025;

/** An onset envelope with a hit every `period` hops, the way a metronome would look. */
const pulsedEnvelope = (count: number, period: number, offset = 0) =>
    Array.from({ length: count }, (_, index) => ((index - offset) % period === 0 ? 10 : 0));

describe('rmsDb', () => {
    it('floors digital silence instead of returning minus infinity', () => {
        expect(rmsDb(new Float32Array(64))).toBe(SILENCE_DB);
        expect(rmsDb(new Float32Array(0))).toBe(SILENCE_DB);
    });

    it('reads a full-scale sine at the 3dB below peak it actually sits at', () => {
        const samples = Float32Array.from({ length: 1024 }, (_, i) => Math.sin(i * 2 * Math.PI / 64));
        expect(rmsDb(samples)).toBeCloseTo(-3.01, 1);
    });

    it('halving the amplitude costs six decibels', () => {
        const loud = new Float32Array(64).fill(0.5);
        const quiet = new Float32Array(64).fill(0.25);
        expect(rmsDb(loud) - rmsDb(quiet)).toBeCloseTo(6.02, 1);
    });
});

describe('spectralFlux', () => {
    it('counts energy arriving and ignores energy leaving', () => {
        const previous = Float32Array.from([-40, -40, -40, -40]);
        const rising = Float32Array.from([-30, -40, -40, -40]);
        const falling = Float32Array.from([-50, -40, -40, -40]);

        expect(spectralFlux(rising, previous, 4)).toBeCloseTo(10, 6);
        // A decaying sustain is not an onset; counting it would smear every hit into the one after.
        expect(spectralFlux(falling, previous, 4)).toBe(0);
    });

    it('looks only as far up the spectrum as it was asked to', () => {
        const previous = Float32Array.from([-40, -40, -40, -40]);
        const current = Float32Array.from([-40, -40, -10, -10]);
        expect(spectralFlux(current, previous, 2)).toBe(0);
    });

    it('treats an empty bin as silence rather than poisoning the sum', () => {
        const previous = Float32Array.from([-Infinity, -40]);
        const current = Float32Array.from([-40, -40]);
        expect(Number.isFinite(spectralFlux(current, previous, 2))).toBe(true);
    });
});

describe('estimateTempo', () => {
    it('recovers the tempo of a steady pulse', () => {
        // A hit every 20 hops of 25ms is one every half second: 120 BPM.
        const estimate = estimateTempo(pulsedEnvelope(320, 20), HOP);

        expect(estimate).not.toBeNull();
        expect(estimate!.bpm).toBeCloseTo(120, 5);
        expect(estimate!.periodSec).toBeCloseTo(0.5, 5);
        expect(estimate!.confidence).toBeGreaterThan(MIN_TEMPO_CONFIDENCE);
    });

    it('says where in the bar the newest sample fell', () => {
        // Beats on 5, 25, ... so the last one before sample 319 is 305, fourteen hops back.
        const estimate = estimateTempo(pulsedEnvelope(320, 20, 5), HOP);
        expect(estimate!.beatOffsetHops).toBe(14);
    });

    it('does not settle on half the tempo when both are equally periodic', () => {
        // Every hit at 30 hops also correlates at 60; the raw peak is ambiguous and the prior
        // is what keeps the answer in the range music is actually written in.
        const estimate = estimateTempo(pulsedEnvelope(400, 30), HOP);
        expect(estimate!.bpm).toBeCloseTo(80, 5);
    });

    it('refuses rather than guessing when there is no pulse to find', () => {
        expect(estimateTempo(new Array(320).fill(1), HOP)).toBeNull();
        expect(estimateTempo(new Array(320).fill(0), HOP)).toBeNull();
    });

    it('refuses before there is enough history to measure the slowest tempo three times', () => {
        expect(estimateTempo(pulsedEnvelope(60, 20), HOP)).toBeNull();
    });

    it('refuses when the sampler never reported a usable rate', () => {
        expect(estimateTempo(pulsedEnvelope(320, 20), 0)).toBeNull();
    });
});

describe('crossoverFor', () => {
    it('hands a loud dense outro over early, before it buries what is arriving', () => {
        expect(crossoverFor(-8)).toBeCloseTo(CROSSOVER_EARLY, 6);
    });

    it('lets a quiet decaying tail run', () => {
        expect(crossoverFor(-45)).toBeCloseTo(CROSSOVER_LATE, 6);
    });

    it('sits in the middle when the deck was never measured', () => {
        const middle = (CROSSOVER_EARLY + CROSSOVER_LATE) / 2;
        expect(crossoverFor(null)).toBeCloseTo(middle, 6);
        expect(crossoverFor(NaN)).toBeCloseTo(middle, 6);
    });

    it('moves the handover earlier the louder the outgoing track is', () => {
        expect(crossoverFor(-16)).toBeLessThan(crossoverFor(-24));
    });
});

describe('trimForBalance', () => {
    it('pulls the outgoing track down by the difference between the two masters', () => {
        expect(trimForBalance(-14, -18)).toBeCloseTo(4, 6);
    });

    it('never lifts the incoming track, whichever way the difference goes', () => {
        expect(trimForBalance(-20, -14)).toBe(0);
    });

    it('stops well short of gutting the track that is still playing', () => {
        expect(trimForBalance(-6, -40)).toBe(MAX_TRIM_DB);
    });
});

describe('planBlendShape', () => {
    const base = {
        overlap: 5,
        outgoingDb: -20,
        nextBeatIn: null,
        periodSec: null,
        minOverlap: 0.8,
        maxOverlap: 5,
    };
    // -20dBFS sits five eighths of the way up the loud/quiet range, so the handover lands here.
    const CROSSOVER = 0.425;

    it('keeps the planned length when there is no beat grid to work with', () => {
        const shape = planBlendShape(base);
        expect(shape.overlap).toBe(5);
        expect(shape.crossover).toBeCloseTo(CROSSOVER, 6);
        expect(shape.snappedToBeat).toBe(false);
    });

    it('moves the handover onto a beat of the outgoing track', () => {
        // 120 BPM with the next beat 0.1s away: beats at 0.1, 0.6, 1.1, 1.6, 2.1, ...
        const shape = planBlendShape({ ...base, nextBeatIn: 0.1, periodSec: 0.5 });

        expect(shape.snappedToBeat).toBe(true);
        expect(shape.overlap * shape.crossover).toBeCloseTo(2.1, 6);
    });

    it('never fades past what the outgoing track has left', () => {
        // The nearest beat would want a longer blend than the track can still supply.
        const shape = planBlendShape({ ...base, nextBeatIn: 0.35, periodSec: 0.5, maxOverlap: 5 });

        expect(shape.overlap).toBeLessThanOrEqual(5);
    });

    it('leaves the length alone rather than distorting it to reach a distant beat', () => {
        // A beat grid this slow would stretch a five second blend to nine.
        const shape = planBlendShape({ ...base, nextBeatIn: 3.9, periodSec: 4, maxOverlap: 20 });

        expect(shape.snappedToBeat).toBe(false);
        expect(shape.overlap).toBe(5);
    });

    it('ignores a grid whose period makes no sense', () => {
        expect(planBlendShape({ ...base, nextBeatIn: 0.1, periodSec: 0 }).snappedToBeat).toBe(false);
    });
});

describe('buildCrossfadeCurves', () => {
    it('sums to constant power wherever the handover is put', () => {
        for (const crossover of [0.2, 0.35, 0.5, 0.8]) {
            const { out, in: incoming } = buildCrossfadeCurves(crossover);
            for (let index = 0; index < out.length; index += 1) {
                expect(out[index] ** 2 + incoming[index] ** 2).toBeCloseTo(1, 5);
            }
        }
    });

    it('starts and ends on a complete handover', () => {
        const { out, in: incoming } = buildCrossfadeCurves(0.3);
        expect(out[0]).toBeCloseTo(1, 6);
        expect(out.at(-1)).toBeCloseTo(0, 6);
        expect(incoming[0]).toBeCloseTo(0, 6);
        expect(incoming.at(-1)).toBeCloseTo(1, 6);
    });

    it('makes the incoming track climb faster than the outgoing one falls when asked to', () => {
        const early = buildCrossfadeCurves(0.3);
        const even = buildCrossfadeCurves(0.5);
        const quarter = Math.floor((early.in.length - 1) / 4);

        expect(early.in[quarter]).toBeGreaterThan(even.in[quarter]);
    });

    it('refuses a handover so lopsided that one side barely moves', () => {
        const { out } = buildCrossfadeCurves(0.001);
        // Clamped, so the first quarter still descends rather than dropping to nothing at once.
        expect(out[Math.floor((out.length - 1) / 4)]).toBeGreaterThan(0.3);
    });
});
