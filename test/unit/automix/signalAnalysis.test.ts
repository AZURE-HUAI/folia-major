import { describe, expect, it } from 'vitest';
import {
    buildBandCurves,
    buildCrossfadeCurves,
    crossoverFor,
    dbToGain,
    estimateDownbeat,
    estimateTempo,
    kWeight,
    planBlendShape,
    rmsDb,
    spectralFlux,
    toneTilt,
    trimForBalance,
    BLEND_HEADROOM_DB,
    CROSSOVER_EARLY,
    MAX_TILT_DB,
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
        expect(crossoverFor(-38)).toBeCloseTo(CROSSOVER_LATE, 6);
    });

    it('stops waiting for a track that has already faded to nothing', () => {
        // Waiting on silence is a hole in the music, not a decaying tail worth preserving.
        expect(crossoverFor(-60)).toBeCloseTo(CROSSOVER_EARLY, 6);
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

describe('kWeight', () => {
    const RATE = 48000;
    const tone = (hz: number, seconds = 1) => {
        const samples = new Float32Array(Math.round(seconds * RATE));
        for (let index = 0; index < samples.length; index += 1) {
            samples[index] = Math.sin((2 * Math.PI * hz * index) / RATE);
        }
        return samples;
    };
    /** Steady-state level, past the filter's own settling. */
    const levelOf = (samples: Float32Array) => rmsDb(samples.subarray(RATE / 2));

    it('leaves the middle alone, lifts the top and throws the rumble away', () => {
        // The shape the whole of broadcasting normalises to. What it buys here is that two tracks
        // at the same RMS but different spectral balance stop reading as equally loud, which is
        // exactly the case a blend gets wrong: the denser master sits on top of the other one.
        const shift = (hz: number) => levelOf(kWeight(tone(hz), RATE)) - levelOf(tone(hz));
        // The shelf's corner is at 1.7kHz, so a kilohertz is already on its way up - but by well
        // under a decibel, which is the sense in which the middle is left alone.
        expect(Math.abs(shift(1000))).toBeLessThan(1);
        expect(shift(8000)).toBeCloseTo(4, 0);
        expect(shift(8000) - shift(1000)).toBeGreaterThan(2.5);
        expect(shift(20)).toBeLessThan(-10);
    });

    it('has nothing to say about nothing', () => {
        expect(kWeight(new Float32Array(0), RATE)).toHaveLength(0);
        expect(kWeight(tone(100, 0.01), 0)).toHaveLength(Math.round(0.01 * RATE));
    });
});

describe('estimateDownbeat', () => {
    // A kick on the one of every bar and a weaker one on the three: the pattern of essentially all
    // of the music this plays, and the reason the bottom of the spectrum is where the bar is.
    const HOP = 0.01;
    const PERIOD = 0.5;
    const pattern = (bars: number, strong = 1, mid = 0.4) => {
        const envelope = new Array<number>(Math.round(bars * PERIOD * 4 / HOP)).fill(0.02);
        for (let bar = 0; bar < bars; bar += 1) {
            const at = (beat: number) => Math.round((bar * 4 + beat) * PERIOD / HOP);
            envelope[at(0)] = strong;
            envelope[at(2)] = mid;
        }
        return envelope;
    };

    it('picks the beat the kick drum is on out of the four candidates', () => {
        expect(estimateDownbeat(pattern(8), HOP, PERIOD, 0)).toBeCloseTo(0, 6);
    });

    it('follows the pattern rather than the grid when the two disagree', () => {
        // Offset the grid by one beat: the answer has to move with the drum, not with the phase it
        // was handed. Getting this backwards puts every transition a quarter note out.
        const found = estimateDownbeat(pattern(8), HOP, PERIOD, PERIOD);
        expect(found! % (PERIOD * 4)).toBeCloseTo(0, 2);
    });

    it('declines when the four candidates are indistinguishable', () => {
        // Music with no drums has no bar line to read this way, and saying so is more useful than
        // naming one - a wrong downbeat is worse than an unknown one.
        const flat = new Array<number>(400).fill(0.3);
        expect(estimateDownbeat(flat, HOP, PERIOD, 0)).toBeNull();
        expect(estimateDownbeat(pattern(8), HOP, 0, 0)).toBeNull();
        expect(estimateDownbeat([], HOP, PERIOD, 0)).toBeNull();
    });
});

describe('toneTilt', () => {
    it('bends a bright track towards a dull one, and the other way round', () => {
        const dull = [0.4, 0.55, 0.05];
        const bright = [0.3, 0.45, 0.25];
        // A bright track arriving after a dull one is pulled down at the top on the way in.
        expect(toneTilt(dull, bright)[1]).toBeLessThan(0);
        expect(toneTilt(bright, dull)[1]).toBeGreaterThan(0);
    });

    it('never bends further than a tone match should', () => {
        const [mid, high] = toneTilt([0.9, 0.099, 0.001], [0.001, 0.099, 0.9]);
        expect(Math.abs(mid)).toBeLessThanOrEqual(MAX_TILT_DB);
        expect(Math.abs(high)).toBeLessThanOrEqual(MAX_TILT_DB);
    });

    it('does nothing without both tones', () => {
        expect(toneTilt(null, [0.3, 0.4, 0.3])).toEqual([0, 0]);
        expect(toneTilt([0.3, 0.4, 0.3], undefined)).toEqual([0, 0]);
        // A band with no energy in it is not a measurement of zero brightness.
        expect(toneTilt([0.5, 0.5, 0], [0.3, 0.4, 0.3])[1]).toBe(0);
    });
});

describe('buildBandCurves', () => {
    const base = { crossover: 0.5, swapBass: true, sweepOut: true, tiltDb: [0, 0] as const };

    it('gives the low end to one deck at a time rather than to both a bit', () => {
        // The one thing two overlapping tracks cannot share. The two sides are exact mirrors, so
        // there is a single crossing rather than two fades that happen to meet, and the crossing
        // is brief - a handover, not a shared middle.
        const { out, in: incoming } = buildBandCurves({ ...base });
        const points = out[0].length;

        expect(out[0][0]).toBeCloseTo(0, 5);
        expect(incoming[0].at(-1)).toBeCloseTo(0, 5);
        expect(out[0].at(-1)!).toBeLessThan(-20);
        expect(incoming[0][0]).toBeLessThan(-20);

        let shared = 0;
        for (let index = 0; index < points; index += 1) {
            expect(out[0][index] + incoming[0][index]).toBeCloseTo(out[0].at(-1)!, 4);
            if (out[0][index] < -3 && incoming[0][index] < -3) shared += 1;
        }
        expect(shared / points).toBeLessThan(0.2);
    });

    it('hands the low end over at the crossover, not in the middle', () => {
        const { out } = buildBandCurves({ ...base, crossover: 0.25 });
        const swapped = out[0].findIndex(value => value < -12);
        expect(swapped / (out[0].length - 1)).toBeCloseTo(0.25, 1);
    });
});

describe('buildCrossfadeCurves', () => {
    it('sums to constant power wherever the handover is put', () => {
        for (const crossover of [0.2, 0.35, 0.5, 0.8]) {
            const { out, in: incoming } = buildCrossfadeCurves(crossover);
            for (let index = 0; index < out.length; index += 1) {
                // Both curves carry the same anti-clipping dip, so it cancels out of the ratio
                // between them - which is what constant power is a claim about.
                const headroom = dbToGain(
                    -BLEND_HEADROOM_DB * Math.sin((index / (out.length - 1)) * Math.PI),
                );
                expect(out[index] ** 2 + incoming[index] ** 2).toBeCloseTo(headroom ** 2, 5);
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
