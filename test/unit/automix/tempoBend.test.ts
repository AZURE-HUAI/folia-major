import { describe, expect, it } from 'vitest';
import { TempoBend, tempoBendLatencySec } from '@/services/automix/tempoBendProcessor.js';

// test/unit/automix/tempoBend.test.ts
// The stretcher, exercised as plain arithmetic. The class is deliberately free of every worklet
// global so that the half worth testing can be tested without an audio device.

const RATE = 48000;
const BLOCK = 128;

/** Runs a signal through the stretcher a render block at a time, as a worklet would. */
const bend = (input: Float32Array, pitch: number, channels = 1) => {
    const stretcher = new TempoBend(channels);
    const output = Array.from({ length: channels }, () => new Float32Array(input.length));
    const inBlock = Array.from({ length: channels }, () => new Float32Array(BLOCK));
    const outBlock = Array.from({ length: channels }, () => new Float32Array(BLOCK));

    for (let start = 0; start + BLOCK <= input.length; start += BLOCK) {
        for (const channel of inBlock) channel.set(input.subarray(start, start + BLOCK));
        stretcher.process(inBlock, outBlock, pitch);
        for (let channel = 0; channel < channels; channel += 1) {
            output[channel].set(outBlock[channel], start);
        }
    }
    return output;
};

const sine = (seconds: number, hz: number) => {
    const samples = new Float32Array(Math.round(seconds * RATE));
    for (let index = 0; index < samples.length; index += 1) {
        samples[index] = Math.sin((2 * Math.PI * hz * index) / RATE);
    }
    return samples;
};

/** Frequency from zero crossings over a steady stretch. Good to a fraction of a percent here. */
const frequencyOf = (samples: Float32Array, from: number, to: number) => {
    let crossings = 0;
    for (let index = from + 1; index < to; index += 1) {
        if ((samples[index - 1] < 0) !== (samples[index] < 0)) crossings += 1;
    }
    return (crossings / 2) * (RATE / (to - from));
};

describe('TempoBend', () => {
    it('produces exactly one sample for every sample it is given', () => {
        // The property that makes this safe to leave running for ever. A stretcher that consumed at
        // a different rate than it produced would either starve or grow a buffer without bound, and
        // both of those are the usual reason this is called hard.
        const input = sine(0.5, 440);
        const [output] = bend(input, 0.85);
        expect(output.length).toBe(input.length);
        expect(output.every(Number.isFinite)).toBe(true);
    });

    it('passes a signal through untouched, one latency late, when nothing is asked of it', () => {
        // No splices at unity, so this is an exact delay rather than an approximation. It has to
        // be: the node is in the chain during ordinary playback, not only during a transition.
        const input = sine(0.3, 440);
        const [output] = bend(input, 1);
        const latency = Math.round(tempoBendLatencySec(RATE) * RATE);

        for (let index = 4000; index < 12000; index += 1) {
            expect(output[index]).toBeCloseTo(input[index - latency], 5);
        }
    });

    it('moves the pitch by the factor it is given and leaves the duration alone', () => {
        // The other half of a media element's playbackRate. The element has already moved tempo and
        // pitch together; this puts the pitch back and leaves the tempo where the element put it.
        const input = sine(2, 1000);
        for (const [pitch, expected] of [[0.8, 800], [0.9, 900], [1.25, 1250]] as const) {
            const [output] = bend(input, pitch);
            expect(frequencyOf(output, RATE / 2, RATE * 3 / 2)).toBeCloseTo(expected, -1.5);
        }
    });

    it('keeps its read pointer bounded however long it runs', () => {
        // The splice is what stops the read pointer from drifting away from the write pointer. If
        // it ever stopped keeping up, the output would be silence or a read of unwritten samples.
        const stretcher = new TempoBend(1);
        const input = [new Float32Array(BLOCK)];
        const output = [new Float32Array(BLOCK)];
        for (let index = 0; index < BLOCK; index += 1) {
            input[0][index] = Math.sin((2 * Math.PI * 220 * index) / RATE);
        }

        for (let block = 0; block < 4000; block += 1) stretcher.process(input, output, 1.25);

        const lag = stretcher.written - stretcher.read;
        expect(lag).toBeGreaterThan(0);
        expect(lag).toBeLessThan(4000);
    });

    it('splices both channels at the same place', () => {
        // One decision for all channels. Correlating each separately would let left and right jump
        // to different points, which does not sound like a worse stretch - it tears the image.
        const input = sine(0.5, 440);
        const [left, right] = bend(input, 0.85, 2);
        for (let index = 0; index < left.length; index += 1) {
            expect(left[index]).toBe(right[index]);
        }
    });

    it('does not run away on silence', () => {
        const [output] = bend(new Float32Array(RATE / 2), 0.8);
        expect(output.every(value => value === 0)).toBe(true);
    });
});
