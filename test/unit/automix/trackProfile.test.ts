import { describe, expect, it } from 'vitest';
import { analyseTrack, keyFromChroma } from '@/services/automix/trackProfile';

// test/unit/automix/trackProfile.test.ts

const RATE = 22050;

const silence = (seconds: number) => new Float32Array(Math.round(seconds * RATE));

const tone = (seconds: number, hz: number, amplitude = 0.5) => {
    const samples = new Float32Array(Math.round(seconds * RATE));
    for (let index = 0; index < samples.length; index += 1) {
        samples[index] = amplitude * Math.sin((2 * Math.PI * hz * index) / RATE);
    }
    return samples;
};

const join = (...parts: Float32Array[]) => {
    const total = parts.reduce((sum, part) => sum + part.length, 0);
    const out = new Float32Array(total);
    let offset = 0;
    for (const part of parts) {
        out.set(part, offset);
        offset += part.length;
    }
    return out;
};

/** A chroma vector whose tonic sits at `key`, built from the template the detector matches on. */
const chromaFor = (key: number, weights: readonly number[]) =>
    Array.from({ length: 12 }, (_, pitchClass) => weights[((pitchClass - key) % 12 + 12) % 12]);

const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

describe('keyFromChroma', () => {
    it('rotates the template the right way round', () => {
        // The one thing worth pinning: an off-by-one in the rotation still produces a confident
        // answer, just a consistently wrong one, and every key decision downstream inherits it.
        expect(keyFromChroma(chromaFor(0, MAJOR))).toMatchObject({ key: 0, major: true });
        expect(keyFromChroma(chromaFor(7, MAJOR))).toMatchObject({ key: 7, major: true });
        expect(keyFromChroma(chromaFor(2, MINOR))).toMatchObject({ key: 2, major: false });
    });

    it('reports no confidence when every key fits equally badly', () => {
        expect(keyFromChroma(new Array(12).fill(1)).confidence).toBe(0);
    });
});

describe('analyseTrack', () => {
    it('finds the silence at each end without being told what silence is', () => {
        // The threshold is relative to the track's own peak: an absolute dBFS floor would call a
        // quiet master silent from end to end.
        return analyseTrack(join(silence(1), tone(6, 220), silence(1)), RATE).then(profile => {
            expect(profile).not.toBeNull();
            expect(profile!.duration).toBeCloseTo(8, 1);
            expect(profile!.leadIn).toBeGreaterThan(0.8);
            expect(profile!.leadIn).toBeLessThan(1.1);
            expect(profile!.leadOut).toBeGreaterThan(0.8);
            expect(profile!.leadOut).toBeLessThan(1.1);
        });
    });

    it('calls a track that runs at one level from end to end hot at both ends', async () => {
        const profile = await analyseTrack(tone(8, 220), RATE);
        expect(profile!.startsHot).toBe(true);
        expect(profile!.endsHot).toBe(true);
        expect(profile!.outroSlope).toBeCloseTo(0, 1);
    });

    it('sees a fade-out as a fade-out', async () => {
        const fading = tone(12, 220);
        const from = Math.round(4 * RATE);
        for (let index = from; index < fading.length; index += 1) {
            fading[index] *= 1 - (index - from) / (fading.length - from);
        }
        const profile = await analyseTrack(fading, RATE);
        expect(profile!.endsHot).toBe(false);
        // Steep enough that the chooser reads it as produced rather than as a musical ending.
        expect(profile!.outroSlope).toBeLessThan(-1.5);
    });

    it('reads the tempo off a click track', async () => {
        // 120 BPM: one impulse every half second.
        const clicks = new Float32Array(24 * RATE);
        for (let beat = 0; beat * 0.5 < 24; beat += 1) {
            const at = Math.round(beat * 0.5 * RATE);
            for (let index = 0; index < 220 && at + index < clicks.length; index += 1) {
                clicks[at + index] = (1 - index / 220) * Math.sin((2 * Math.PI * 1000 * index) / RATE);
            }
        }
        const profile = await analyseTrack(clicks, RATE);
        expect(profile!.bpm).toBeGreaterThan(112);
        expect(profile!.bpm).toBeLessThan(128);
    });

    it('refuses to describe something too short to describe', async () => {
        expect(await analyseTrack(tone(0.5, 220), RATE)).toBeNull();
        expect(await analyseTrack(silence(4), RATE)).toBeNull();
    });
});
