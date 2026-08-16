import { vi } from 'vitest';
import type { AutomixDeckChain } from '@/services/automix/crossfadeGraph';

// test/unit/automix/fakeAudioGraph.ts
// Just enough of Web Audio to record what the automix code asks the audio clock to do. Recording
// the automation events rather than the resulting samples is the point: the thing worth asserting
// is the shape of the schedule, which is what a real engine would then render.

export type GainEvent =
    | { type: 'cancel'; time: number }
    | { type: 'set'; time: number; value: number }
    | { type: 'ramp'; time: number; value: number }
    | { type: 'curve'; time: number; duration: number; curve: Float32Array };

export interface FakeGainNode {
    gain: AudioParam;
    events: GainEvent[];
}

export const createFakeGainNode = (): FakeGainNode => {
    const events: GainEvent[] = [];
    let value = 1;

    const gain = {
        get value() { return value; },
        set value(next: number) { value = next; },
        cancelScheduledValues: (time: number) => { events.push({ type: 'cancel', time }); },
        setValueAtTime: (next: number, time: number) => {
            value = next;
            events.push({ type: 'set', time, value: next });
        },
        linearRampToValueAtTime: (next: number, time: number) => {
            events.push({ type: 'ramp', time, value: next });
        },
        setValueCurveAtTime: (curve: Float32Array, time: number, duration: number) => {
            events.push({ type: 'curve', time, duration, curve });
        },
    } as unknown as AudioParam;

    return { gain, events };
};

export const asGain = (node: FakeGainNode) => node as unknown as GainNode;

/** Where an automation sequence is headed, ignoring the cancels and holds along the way. */
export const finalTarget = (node: FakeGainNode): number | null => {
    for (let index = node.events.length - 1; index >= 0; index -= 1) {
        const event = node.events[index];
        if (event.type === 'set' || event.type === 'ramp') return event.value;
    }
    return null;
};

export const lastCurve = (node: FakeGainNode) => {
    for (let index = node.events.length - 1; index >= 0; index -= 1) {
        const event = node.events[index];
        if (event.type === 'curve') return event;
    }
    return null;
};

export interface FakeDeckChain extends AutomixDeckChain {
    fadeNode: FakeGainNode;
    replayGainNode: FakeGainNode;
}

export const createFakeChain = (): FakeDeckChain => {
    const fadeNode = createFakeGainNode();
    const replayGainNode = createFakeGainNode();
    return {
        source: {} as MediaElementAudioSourceNode,
        replayGain: replayGainNode as unknown as GainNode,
        fade: fadeNode as unknown as GainNode,
        fadeNode,
        replayGainNode,
    };
};

export const createFakeContext = (currentTime = 0) => ({ currentTime } as AudioContext);

export interface FakeAudioElement {
    duration: number;
    currentTime: number;
    pause: ReturnType<typeof vi.fn>;
}

export const createFakeElement = (duration = 100, currentTime = 0): FakeAudioElement => ({
    duration,
    currentTime,
    pause: vi.fn(),
});

export const asElement = (element: FakeAudioElement) => element as unknown as HTMLAudioElement;
