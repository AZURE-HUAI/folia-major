import { describe, expect, it } from 'vitest';
import { analyseTrack, keyFromChroma, measureEdges } from '@/services/automix/trackProfile';

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

/** Splits a stereo pair the way profileService does, so the test feeds what production feeds. */
const midSide = (left: Float32Array, right: Float32Array) => {
    const mid = new Float32Array(left.length);
    const side = new Float32Array(left.length);
    for (let index = 0; index < left.length; index += 1) {
        mid[index] = (left[index] + right[index]) / 2;
        side[index] = (left[index] - right[index]) / 2;
    }
    return { mid, side };
};

/** Sums signals into one channel. */
const mix = (...parts: Float32Array[]) => {
    const out = new Float32Array(parts[0].length);
    for (const part of parts) {
        for (let index = 0; index < out.length; index += 1) out[index] += part[index];
    }
    return out;
};

describe('analyseTrack, finding the voice', () => {
    // A stereo mix with the two hands panned apart, and a centred tone arriving partway through.
    // Panned content lands equally in mid and side and cancels to nothing; the centred tone lands
    // only in mid and survives. That difference is the whole mechanism.
    const INTRO_SEC = 6;
    const buildTrack = (vocalHz = 500) => {
        const leftOnly = join(tone(INTRO_SEC, 700, 0.4), tone(6, 700, 0.4));
        const rightOnly = join(tone(INTRO_SEC, 1100, 0.4), tone(6, 1100, 0.4));
        const centred = join(silence(INTRO_SEC), tone(6, vocalHz, 0.4));
        return midSide(mix(leftOnly, centred), mix(rightOnly, centred));
    };

    it('reports where the centred sound starts, not where the track starts', async () => {
        const { mid, side } = buildTrack();
        const profile = await analyseTrack(mid, RATE, { side });

        expect(profile?.leadIn).toBeCloseTo(0, 1);
        expect(profile?.vocalStart).toBeCloseTo(INTRO_SEC, 0);
    });

    it('answers null for a mono file, where there is nothing to cancel', async () => {
        // Every measurement below the vocal band still works; only this one cannot be made.
        const { mid } = buildTrack();
        const profile = await analyseTrack(mid, RATE, { side: null });

        expect(profile?.vocalStart).toBeNull();
        expect(profile?.loudness).toBeLessThan(0);
    });

    it('answers null when nothing centred ever arrives', async () => {
        const leftOnly = tone(12, 700, 0.4);
        const rightOnly = tone(12, 1100, 0.4);
        const { mid, side } = midSide(leftOnly, rightOnly);

        expect((await analyseTrack(mid, RATE, { side }))?.vocalStart).toBeNull();
    });

    it('ignores centred content outside the vocal band', async () => {
        // A centred bass line is not a voice. Without the band limit it reads as one, and every
        // track with a bass guitar reports its intro as zero seconds.
        const { mid, side } = buildTrack(80);

        expect((await analyseTrack(mid, RATE, { side }))?.vocalStart).toBeNull();
    });
});

describe('analyseTrack, finding the structure', () => {
    const chord = (seconds: number, hz: readonly number[]) =>
        mix(...hz.map(one => tone(seconds, one, 0.3)));
    const VERSE = [261.6, 329.6, 392.0];   // C major
    const CHORUS = [293.7, 349.2, 440.0];  // D minor - a different set of pitch classes

    it('puts the first boundary where the music becomes a different thing', async () => {
        // Eight seconds of one harmony, then another. No level change, no tempo change and no
        // voice, so nothing but the self-similarity of the two halves marks the join.
        const profile = await analyseTrack(join(chord(8, VERSE), chord(14, CHORUS)), RATE);

        expect(profile?.sectionStart).toBeCloseTo(8, 0);
    });

    it('finds no boundary in music that never changes', async () => {
        // The checkerboard's two halves cancel exactly here, so what is left is float noise. A
        // sigma test on its own promotes that noise to a boundary; the flatness check is why not.
        expect((await analyseTrack(chord(22, VERSE), RATE))?.sectionStart).toBeNull();
    });

    it('has nothing to say about a track too short to hold the kernel', async () => {
        expect((await analyseTrack(join(chord(2, VERSE), chord(2, CHORUS)), RATE))?.sectionStart)
            .toBeNull();
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

    it('leaves the tail unknown rather than describing where the file was cut off', async () => {
        // A range request off the front of a file decodes as a short track. Everything about its
        // "end" is the truncation, so it has to come back null and not merely wrong.
        const profile = await analyseTrack(join(silence(1), tone(6, 220)), RATE, { partial: true });
        expect(profile!.partial).toBe(true);
        expect(profile!.leadIn).toBeGreaterThan(0.8);
        expect(profile!.startsHot).toBe(true);
        expect(profile!.endsHot).toBeNull();
        expect(profile!.leadOut).toBeNull();
        expect(profile!.outroSlope).toBeNull();
    });

    it('refuses to describe something too short to describe', async () => {
        expect(await analyseTrack(tone(0.5, 220), RATE)).toBeNull();
        expect(await analyseTrack(silence(4), RATE)).toBeNull();
    });
});

describe('measureEdges', () => {
    // The live path samples at 25ms, which is the case that has to hold: the file path's own hop is
    // an order of magnitude finer, so a window sized in frames behaves differently at each.
    const HOP = 0.025;
    const levels = (...runs: { db: number; seconds: number }[]) =>
        runs.flatMap(run => new Array(Math.round(run.seconds / HOP)).fill(run.db));

    it('separates a track that stops at full level from one that decays out', () => {
        const stops = measureEdges(levels({ db: -12, seconds: 40 }), HOP);
        expect(stops).toMatchObject({ endsHot: true });
        expect(stops!.outroSlope).toBeCloseTo(0, 2);

        // A produced fade: the last ten seconds slide from full level down into the floor.
        const fade = Array.from({ length: Math.round(10 / HOP) }, (_, index) =>
            -12 - (index / (10 / HOP)) * 25);
        const fades = measureEdges([...levels({ db: -12, seconds: 30 }), ...fade], HOP);
        expect(fades).toMatchObject({ endsHot: false });
        // Steeper than the chooser's -1.5 dB/s threshold, which is what makes it a fade-out.
        expect(fades!.outroSlope).toBeLessThan(-1.5);
    });

    it('finds the sounding part between the silence at each end', () => {
        const edges = measureEdges(
            levels({ db: -90, seconds: 2 }, { db: -12, seconds: 30 }, { db: -90, seconds: 3 }),
            HOP,
        );
        expect(edges!.leadIn).toBeCloseTo(2, 1);
        expect(edges!.soundingEnd).toBeCloseTo(32, 1);
        // Averaged over the sounding part alone: the trailing silence must not drag it down.
        expect(edges!.loudness).toBeCloseTo(-12, 1);
    });

    it('has no answer for silence, or for no readings at all', () => {
        expect(measureEdges(levels({ db: -90, seconds: 30 }), HOP)).toBeNull();
        expect(measureEdges([], HOP)).toBeNull();
        expect(measureEdges(levels({ db: -12, seconds: 30 }), 0)).toBeNull();
    });
});
