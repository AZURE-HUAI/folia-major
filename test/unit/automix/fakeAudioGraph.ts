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
    | { type: 'exp'; time: number; value: number }
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
        exponentialRampToValueAtTime: (next: number, time: number) => {
            events.push({ type: 'exp', time, value: next });
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
        if (event.type === 'set' || event.type === 'ramp' || event.type === 'exp') return event.value;
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

/** A biquad's frequency is an AudioParam too, so the same recorder describes the bass swap. */
export const createFakeFilter = () => {
    const frequency = createFakeGainNode();
    return {
        node: { type: 'highpass', frequency: frequency.gain, Q: { value: 1 } } as unknown as BiquadFilterNode,
        events: frequency.events,
        param: frequency,
    };
};

export interface FakeDeckChain extends AutomixDeckChain {
    fadeNode: FakeGainNode;
    replayGainNode: FakeGainNode;
    trimNode: FakeGainNode;
    lowCutParam: FakeGainNode;
}

/** Measurements a deck can be told to report, so a blend's shape can be driven from a test. */
export interface FakeAnalyserReadings {
    loudnessDb?: number | null;
    bpm?: number | null;
    /** Seconds from the blend starting to the next beat. */
    nextBeatIn?: number | null;
}

export const createFakeChain = (readings: FakeAnalyserReadings = {}): FakeDeckChain => {
    const fadeNode = createFakeGainNode();
    const replayGainNode = createFakeGainNode();
    const trimNode = createFakeGainNode();
    const lowCut = createFakeFilter();
    const bpm = readings.bpm ?? null;

    return {
        source: {} as MediaElementAudioSourceNode,
        replayGain: replayGainNode as unknown as GainNode,
        trim: trimNode as unknown as GainNode,
        lowCut: lowCut.node,
        fade: fadeNode as unknown as GainNode,
        analyser: {
            tick: () => { },
            loudnessDb: () => readings.loudnessDb ?? null,
            tempo: () => (bpm === null
                ? null
                : { bpm, periodSec: 60 / bpm, confidence: 1, beatOffsetHops: 0 }),
            nextBeatIn: () => readings.nextBeatIn ?? null,
            reset: () => { },
        },
        fadeNode,
        replayGainNode,
        trimNode,
        lowCutParam: lowCut.param,
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
