import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Line } from '@/types';
import {
    createAutomixSession,
    type AutomixDeckId,
    type AutomixSessionPorts,
} from '@/services/automix/automixSession';
import type { TransitionTrack } from '@/services/automix/transitionPlanner';
import {
    asElement,
    createFakeChain,
    createFakeContext,
    createFakeElement,
    finalTarget,
    lastCurve,
    type FakeAudioElement,
    type FakeDeckChain,
} from './fakeAudioGraph';

// test/unit/automix/automixSession.test.ts
// Exercises the arm -> fade -> settle machine and, just as importantly, every path that refuses.

const line = (startTime: number, endTime: number, fullText = 'la'): Line => ({
    words: [], startTime, endTime, fullText,
});

/** A pair with a six second instrumental outro and a five second instrumental intro. */
const BLENDABLE_FROM: TransitionTrack = { duration: 100, lines: [line(10, 94)] };
const BLENDABLE_TO: TransitionTrack = { duration: 100, lines: [line(5, 90)] };

const createHarness = () => {
    // Deck A sits exactly on the planned outStart: a six second outro against a five second
    // intro gives a five second overlap, so the track has five seconds left to give.
    const elements: Record<AutomixDeckId, FakeAudioElement> = {
        A: createFakeElement(100, 95),
        B: createFakeElement(100, 0),
    };
    const chains: Record<AutomixDeckId, FakeDeckChain> = { A: createFakeChain(), B: createFakeChain() };
    const context = createFakeContext();

    const activeDeckChanges: AutomixDeckId[] = [];
    const tailSrcChanges: (string | null)[] = [];
    const advanceTrack = vi.fn();

    const ports: AutomixSessionPorts = {
        getContext: () => context,
        getElement: deck => asElement(elements[deck]),
        getChain: deck => chains[deck],
        onActiveDeckChange: deck => { activeDeckChanges.push(deck); },
        onTailSrcChange: src => { tailSrcChanges.push(src); },
        advanceTrack,
    };

    const session = createAutomixSession(ports);

    /** Drives the machine to the point where the incoming deck is about to be heard. */
    const arm = (overrides: Partial<Parameters<typeof session.requestTransition>[0]> = {}) => (
        session.requestTransition({
            time: 95,
            audioSrc: 'outgoing.mp3',
            from: BLENDABLE_FROM,
            to: BLENDABLE_TO,
            nextKey: 'local:next-song',
            ...overrides,
        })
    );

    return { session, elements, chains, context, activeDeckChanges, tailSrcChanges, advanceTrack, arm };
};

describe('automix session', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.spyOn(console, 'log').mockImplementation(() => { });
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('leaves the track alone until the planned overlap actually starts', () => {
        const harness = createHarness();

        const plan = harness.arm({ time: 90 });

        expect(plan?.kind).toBe('fade');
        expect(harness.session.getPhase()).toBe('idle');
        expect(harness.advanceTrack).not.toHaveBeenCalled();
    });

    it('hands the deck role over and requests the next track once the overlap begins', () => {
        const harness = createHarness();

        harness.arm();

        expect(harness.session.getPhase()).toBe('armed');
        expect(harness.session.getActiveDeck()).toBe('B');
        expect(harness.activeDeckChanges).toEqual(['B']);
        // Pinned before the roles moved, so the outgoing deck's src never changes and its
        // playback is never interrupted.
        expect(harness.tailSrcChanges).toEqual(['outgoing.mp3']);
        expect(harness.advanceTrack).toHaveBeenCalledTimes(1);
    });

    it('silences the incoming deck before it is allowed to make a sound', () => {
        const harness = createHarness();

        harness.arm();

        expect(finalTarget(harness.chains.B.fadeNode)).toBe(0);
    });

    it('never starts the next track early when there is no fade to schedule', () => {
        const harness = createHarness();

        // A stream of unknown length: there is no end to place a fade before.
        const plan = harness.arm({ from: { duration: Infinity, lines: [line(10, 94)] } });

        expect(plan?.kind).toBe('hardCut');
        expect(harness.session.getPhase()).toBe('idle');
        expect(harness.session.getActiveDeck()).toBe('A');
        expect(harness.advanceTrack).not.toHaveBeenCalled();
    });

    it('arms two tracks that sing end to end rather than declining them', () => {
        const harness = createHarness();

        const plan = harness.arm({
            from: { duration: 100, lines: [line(10, 99.9)] },
            to: { duration: 100, lines: [line(0.1, 90)] },
        });

        expect(plan?.kind).toBe('fade');
        expect(harness.session.getPhase()).toBe('armed');
        expect(harness.advanceTrack).toHaveBeenCalledTimes(1);
    });

    it('schedules complementary curves over the planned overlap once the incoming deck plays', () => {
        const harness = createHarness();
        harness.arm();

        harness.session.handleActiveDeckPlaying('local:next-song');

        expect(harness.session.getPhase()).toBe('fading');
        const outgoing = lastCurve(harness.chains.A.fadeNode);
        const incoming = lastCurve(harness.chains.B.fadeNode);
        expect(outgoing?.duration).toBe(5);
        expect(incoming?.duration).toBe(5);
        expect(outgoing?.curve[0]).toBeCloseTo(1, 6);
        expect(outgoing?.curve.at(-1)).toBeCloseTo(0, 6);
        expect(incoming?.curve[0]).toBeCloseTo(0, 6);
        expect(incoming?.curve.at(-1)).toBeCloseTo(1, 6);
    });

    it('drops the blend when the queue moved to a song it never measured', () => {
        const harness = createHarness();
        harness.arm();

        harness.session.handleActiveDeckPlaying('local:some-other-song');

        expect(lastCurve(harness.chains.B.fadeNode)).toBeNull();
        expect(finalTarget(harness.chains.A.fadeNode)).toBe(0);
        expect(finalTarget(harness.chains.B.fadeNode)).toBe(1);
    });

    it('drops the blend when the outgoing track ran out while the next one loaded', () => {
        const harness = createHarness();
        harness.arm();
        // Only 0.4s left by the time the incoming deck finally started.
        harness.elements.A.currentTime = 99.6;

        harness.session.handleActiveDeckPlaying('local:next-song');

        expect(lastCurve(harness.chains.B.fadeNode)).toBeNull();
        expect(finalTarget(harness.chains.B.fadeNode)).toBe(1);
    });

    it('clamps the blend to the time the outgoing track actually has left', () => {
        const harness = createHarness();
        harness.arm();
        harness.elements.A.currentTime = 97.5;

        harness.session.handleActiveDeckPlaying('local:next-song');

        expect(lastCurve(harness.chains.A.fadeNode)?.duration).toBe(2.5);
    });

    it('releases both decks once the overlap has elapsed', () => {
        const harness = createHarness();
        harness.arm();
        harness.session.handleActiveDeckPlaying('local:next-song');

        vi.advanceTimersByTime(5_200);

        expect(harness.session.getPhase()).toBe('idle');
        expect(harness.elements.A.pause).toHaveBeenCalled();
        expect(harness.tailSrcChanges.at(-1)).toBeNull();
        expect(finalTarget(harness.chains.A.fadeNode)).toBe(1);
        expect(finalTarget(harness.chains.B.fadeNode)).toBe(1);
    });

    it('gives the role back when the next track never arrives', () => {
        const harness = createHarness();
        harness.arm();

        harness.session.handleTailEnded();

        expect(harness.session.getPhase()).toBe('idle');
        expect(harness.session.getActiveDeck()).toBe('A');
        expect(harness.activeDeckChanges).toEqual(['B', 'A']);
        expect(harness.tailSrcChanges.at(-1)).toBeNull();
    });

    it('lets the scheduled ramp finish when the outgoing track ends on cue', () => {
        const harness = createHarness();
        harness.arm();
        harness.session.handleActiveDeckPlaying('local:next-song');
        const incomingEventCount = harness.chains.B.fadeNode.events.length;

        harness.session.handleTailEnded();

        expect(harness.session.getPhase()).toBe('fading');
        expect(harness.chains.B.fadeNode.events).toHaveLength(incomingEventCount);
    });

    it('ends the transition and restores the role when playback is paused while armed', () => {
        const harness = createHarness();
        harness.arm();

        // True tells the caller the in-flight advance still has to have its autoplay suppressed.
        expect(harness.session.abort()).toBe(true);

        expect(harness.session.getPhase()).toBe('idle');
        expect(harness.session.getActiveDeck()).toBe('A');
        // Deck A is the one actually making a sound while armed, so it is the one to stop.
        expect(harness.elements.A.pause).toHaveBeenCalled();
        expect(finalTarget(harness.chains.B.fadeNode)).toBe(1);
    });

    it('reports nothing to suppress when the pause lands mid-blend', () => {
        const harness = createHarness();
        harness.arm();
        harness.session.handleActiveDeckPlaying('local:next-song');

        // The next track is already playing by now, so its autoplay is not pending.
        expect(harness.session.abort()).toBe(false);
        expect(harness.session.getActiveDeck()).toBe('B');
    });

    it('forces a deck playing outside a transition back to unity', () => {
        const harness = createHarness();
        // A blend that was cancelled could have left this deck silent; nothing else would fix it.
        harness.chains.A.fade.gain.value = 0;

        harness.session.handleActiveDeckPlaying('local:whatever');

        expect(finalTarget(harness.chains.A.fadeNode)).toBe(1);
    });

    it('alternates the decks across consecutive transitions', () => {
        const harness = createHarness();

        harness.arm();
        harness.session.handleActiveDeckPlaying('local:next-song');
        vi.advanceTimersByTime(5_200);
        expect(harness.session.getActiveDeck()).toBe('B');

        harness.elements.B.currentTime = 96;
        harness.arm({ audioSrc: 'second.mp3', nextKey: 'local:third-song' });

        expect(harness.session.getActiveDeck()).toBe('A');
        expect(harness.tailSrcChanges.at(-1)).toBe('second.mp3');
    });

    it('ignores a second request while a transition is already running', () => {
        const harness = createHarness();
        harness.arm();

        expect(harness.arm()).toBeNull();
        expect(harness.advanceTrack).toHaveBeenCalledTimes(1);
    });
});
