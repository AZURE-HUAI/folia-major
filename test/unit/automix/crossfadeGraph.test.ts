import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    CROSSFADE_IN_CURVE,
    CROSSFADE_OUT_CURVE,
    rampGain,
    scheduleCrossfade,
} from '@/services/automix/crossfadeGraph';
import { asGain, createFakeContext, createFakeGainNode, finalTarget } from './fakeAudioGraph';

// test/unit/automix/crossfadeGraph.test.ts

describe('crossfade curves', () => {
    it('hands loudness over at constant power rather than dipping in the middle', () => {
        // Two uncorrelated songs summed on a linear pair lose about 3dB halfway through; the
        // whole reason for a cosine pair is that this stays at one all the way across.
        for (let index = 0; index < CROSSFADE_OUT_CURVE.length; index += 1) {
            const power = CROSSFADE_OUT_CURVE[index] ** 2 + CROSSFADE_IN_CURVE[index] ** 2;
            expect(power).toBeCloseTo(1, 5);
        }
    });

    it('starts and ends on full handover', () => {
        expect(CROSSFADE_OUT_CURVE[0]).toBeCloseTo(1, 6);
        expect(CROSSFADE_OUT_CURVE.at(-1)).toBeCloseTo(0, 6);
        expect(CROSSFADE_IN_CURVE[0]).toBeCloseTo(0, 6);
        expect(CROSSFADE_IN_CURVE.at(-1)).toBeCloseTo(1, 6);
    });

    it('descends and ascends monotonically, so neither track wobbles on the way', () => {
        for (let index = 1; index < CROSSFADE_OUT_CURVE.length; index += 1) {
            expect(CROSSFADE_OUT_CURVE[index]).toBeLessThan(CROSSFADE_OUT_CURVE[index - 1]);
            expect(CROSSFADE_IN_CURVE[index]).toBeGreaterThan(CROSSFADE_IN_CURVE[index - 1]);
        }
    });
});

describe('scheduleCrossfade', () => {
    afterEach(() => vi.restoreAllMocks());

    it('puts both ramps on the audio clock over the same window', () => {
        const context = createFakeContext(12.5);
        const outgoing = createFakeGainNode();
        const incoming = createFakeGainNode();

        expect(scheduleCrossfade(context, asGain(outgoing), asGain(incoming), 4)).toBe(true);

        expect(outgoing.events).toContainEqual({
            type: 'curve', time: 12.5, duration: 4, curve: CROSSFADE_OUT_CURVE,
        });
        expect(incoming.events).toContainEqual({
            type: 'curve', time: 12.5, duration: 4, curve: CROSSFADE_IN_CURVE,
        });
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
});
