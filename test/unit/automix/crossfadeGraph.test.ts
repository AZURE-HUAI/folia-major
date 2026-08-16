import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    BASS_OPEN_HZ,
    BASS_SWAP_HZ,
    rampGain,
    rampGainDb,
    scheduleBassSwap,
    scheduleCrossfade,
} from '@/services/automix/crossfadeGraph';
import {
    asGain,
    createFakeContext,
    createFakeFilter,
    createFakeGainNode,
    finalTarget,
    lastCurve,
} from './fakeAudioGraph';

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

describe('scheduleCrossfade, held', () => {
    it('keeps the incoming deck silent until the handover moment', () => {
        // The incoming deck starts when the media element manages to start, not when we ask. So
        // placing a handover anywhere other than "now" means letting it run muted until then -
        // which is what makes a cut a cut and a splice a splice.
        const context = createFakeContext(10);
        const outgoing = createFakeGainNode();
        const incoming = createFakeGainNode();

        scheduleCrossfade(context, asGain(outgoing), asGain(incoming), 0.04, 0.5, 1.2);

        expect(incoming.events).toContainEqual({ type: 'set', time: 10, value: 0 });
        expect(outgoing.events).toContainEqual({ type: 'set', time: 10, value: 1 });
        expect(lastCurve(incoming)).toMatchObject({ time: 11.2, duration: 0.04 });
        expect(lastCurve(outgoing)).toMatchObject({ time: 11.2, duration: 0.04 });
    });
});

describe('scheduleBassSwap', () => {
    const run = (seconds = 4, crossover = 0.5) => {
        const context = createFakeContext(0);
        const outgoing = createFakeFilter();
        const incoming = createFakeFilter();
        scheduleBassSwap(context, outgoing.node, incoming.node, 0, seconds, crossover);
        return { outgoing, incoming };
    };

    it('brings the incoming track in without its bass and hands the low end over', () => {
        const { outgoing, incoming } = run();

        expect(incoming.events[1]).toMatchObject({ type: 'set', time: 0, value: BASS_SWAP_HZ });
        expect(incoming.events.at(-1)).toMatchObject({ type: 'exp', value: BASS_OPEN_HZ });
        expect(outgoing.events[1]).toMatchObject({ type: 'set', time: 0, value: BASS_OPEN_HZ });
        expect(outgoing.events.at(-1)).toMatchObject({ type: 'exp', value: BASS_SWAP_HZ });
    });

    it('swaps around the crossover, not around the middle', () => {
        const { incoming } = run(4, 0.25);

        // Crossover at 1s, so the sweep is centred there rather than at 2s.
        const hold = incoming.events[2] as { time: number };
        const end = incoming.events[3] as { time: number };
        expect((hold.time + end.time) / 2).toBeCloseTo(1, 6);
    });

    it('finishes the sweep inside the blend even when the handover is right at the edge', () => {
        // Otherwise a deck is still sweeping after the other one has gone, and the swap is heard
        // as a filter move rather than as the two tracks changing places.
        const { incoming } = run(1, 0.9);

        const end = incoming.events.at(-1) as { time: number };
        expect(end.time).toBeLessThanOrEqual(1);
        expect((incoming.events[2] as { time: number }).time).toBeGreaterThanOrEqual(0);
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
