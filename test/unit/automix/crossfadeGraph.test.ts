import { afterEach, describe, expect, it, vi } from 'vitest';
import { rampGain, rampGainDb, scheduleCrossfade } from '@/services/automix/crossfadeGraph';
import { asGain, createFakeContext, createFakeGainNode, finalTarget, lastCurve } from './fakeAudioGraph';

// test/unit/automix/crossfadeGraph.test.ts

describe('scheduleCrossfade', () => {
    afterEach(() => vi.restoreAllMocks());

    it('puts both ramps on the audio clock over the same window', () => {
        const context = createFakeContext(12.5);
        const outgoing = createFakeGainNode();
        const incoming = createFakeGainNode();

        expect(scheduleCrossfade(context, asGain(outgoing), asGain(incoming), 4)).toBe(true);

        expect(lastCurve(outgoing)).toMatchObject({ time: 12.5, duration: 4 });
        expect(lastCurve(incoming)).toMatchObject({ time: 12.5, duration: 4 });
    });

    it('hands loudness over at constant power rather than dipping in the middle', () => {
        // Two uncorrelated songs summed on a linear pair lose about 3dB halfway through, and the
        // blend audibly sags. That has to hold wherever the handover is put, not only at 50%.
        const context = createFakeContext();
        const outgoing = createFakeGainNode();
        const incoming = createFakeGainNode();

        scheduleCrossfade(context, asGain(outgoing), asGain(incoming), 4, 0.3);

        const out = lastCurve(outgoing)!.curve;
        const into = lastCurve(incoming)!.curve;
        for (let index = 0; index < out.length; index += 1) {
            expect(out[index] ** 2 + into[index] ** 2).toBeCloseTo(1, 5);
        }
    });

    it('starts and ends on full handover, moving one way the whole time', () => {
        const context = createFakeContext();
        const outgoing = createFakeGainNode();
        const incoming = createFakeGainNode();

        scheduleCrossfade(context, asGain(outgoing), asGain(incoming), 4, 0.35);

        const out = lastCurve(outgoing)!.curve;
        const into = lastCurve(incoming)!.curve;
        expect(out[0]).toBeCloseTo(1, 6);
        expect(out.at(-1)).toBeCloseTo(0, 6);
        expect(into[0]).toBeCloseTo(0, 6);
        expect(into.at(-1)).toBeCloseTo(1, 6);
        for (let index = 1; index < out.length; index += 1) {
            expect(out[index]).toBeLessThan(out[index - 1]);
            expect(into[index]).toBeGreaterThan(into[index - 1]);
        }
    });

    it('reaches the halfway point where the crossover says, not in the middle', () => {
        const context = createFakeContext();
        const outgoing = createFakeGainNode();
        const incoming = createFakeGainNode();

        scheduleCrossfade(context, asGain(outgoing), asGain(incoming), 4, 0.3);

        const out = lastCurve(outgoing)!.curve;
        const crossing = out.findIndex(value => value <= Math.SQRT1_2);
        expect(crossing / (out.length - 1)).toBeCloseTo(0.3, 1);
    });

    it('leaves both decks in a defined state when the engine rejects the curves', () => {
        vi.spyOn(console, 'warn').mockImplementation(() => { });
        const context = createFakeContext();
        const outgoing = createFakeGainNode();
        const incoming = createFakeGainNode();
        vi.spyOn(outgoing.gain, 'setValueCurveAtTime').mockImplementation(() => {
            throw new DOMException('overlaps a running curve', 'NotSupportedError');
        });

        expect(scheduleCrossfade(context, asGain(outgoing), asGain(incoming), 4)).toBe(false);

        // A blend is optional. An incoming deck stuck at zero gain is silent playback.
        expect(finalTarget(incoming)).toBe(1);
        expect(finalTarget(outgoing)).toBe(0);
    });
});

describe('rampGain', () => {
    it('sets the value outright when given no time', () => {
        const context = createFakeContext(3);
        const node = createFakeGainNode();

        rampGain(context, asGain(node), 0.25);

        expect(node.events).toEqual([
            { type: 'cancel', time: 3 },
            { type: 'set', time: 3, value: 0.25 },
        ]);
    });

    it('holds the current value before ramping, so the move starts where the gain actually is', () => {
        const context = createFakeContext(3);
        const node = createFakeGainNode();
        node.gain.value = 0.4;

        rampGain(context, asGain(node), 1, 0.05);

        expect(node.events).toEqual([
            { type: 'cancel', time: 3 },
            { type: 'set', time: 3, value: 0.4 },
            { type: 'ramp', time: 3.05, value: 1 },
        ]);
    });

    it('converts dB to the linear gain the engine wants', () => {
        const context = createFakeContext();
        const node = createFakeGainNode();

        rampGainDb(context, asGain(node), -6, 0.4);

        expect(finalTarget(node)).toBeCloseTo(0.501, 3);
    });
});
