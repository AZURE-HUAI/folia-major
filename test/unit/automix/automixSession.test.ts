import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Line } from '@/types';
import {
    createAutomixSession,
    type AutomixDeckId,
    type AutomixSessionPorts,
} from '@/services/automix/automixSession';
import type { TransitionTrack } from '@/services/automix/transitionPlanner';
import { TRACK_PROFILE_VERSION, type TrackProfile } from '@/services/automix/trackProfile';
import {
    asElement,
    createFakeChain,
    createFakeContext,
    createFakeElement,
    finalTarget,
    lastCurve,
    type FakeAnalyserReadings,
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

const createHarness = (readings: Partial<Record<AutomixDeckId, FakeAnalyserReadings>> = {}) => {
    // Deck A sits exactly on the planned outStart: a six second outro against a five second
    // intro gives a five second overlap, so the track has five seconds left to give.
    const elements: Record<AutomixDeckId, FakeAudioElement> = {
        A: createFakeElement(100, 95),
        B: createFakeElement(100, 0),
    };
    const chains: Record<AutomixDeckId, FakeDeckChain> = {
        A: createFakeChain(readings.A),
        B: createFakeChain(readings.B),
    };
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

    it('holds the outgoing track down when it is measurably the louder of the two', () => {
        // Equal power is not equal loudness: masters differ by up to 10dB across a library, and
        // that difference is exactly what "the old song sits on top of the new one" sounds like.
        const harness = createHarness({ A: { loudnessDb: -10 }, B: { loudnessDb: -20 } });
        harness.arm();
        harness.session.handleActiveDeckPlaying('local:next-song');

        vi.advanceTimersByTime(150);

        expect(finalTarget(harness.chains.A.trimNode)).toBeCloseTo(0.501, 3);
        // The arriving track is never lifted: that risks clipping and has to be undone afterwards.
        expect(harness.chains.B.trimNode.events).toHaveLength(0);
    });

    it('leaves the levels alone when the track arriving is the louder one', () => {
        const harness = createHarness({ A: { loudnessDb: -24 }, B: { loudnessDb: -14 } });
        harness.arm();
        harness.session.handleActiveDeckPlaying('local:next-song');

        vi.advanceTimersByTime(300);

        expect(harness.chains.A.trimNode.events).toHaveLength(0);
    });

    it('gives the trim back so the deck is not still attenuated next time it is used', () => {
        const harness = createHarness({ A: { loudnessDb: -10 }, B: { loudnessDb: -20 } });
        harness.arm();
        harness.session.handleActiveDeckPlaying('local:next-song');

        vi.advanceTimersByTime(5_200);

        expect(finalTarget(harness.chains.A.trimNode)).toBe(1);
    });

    it('lands the handover on a beat of the outgoing track', () => {
        const harness = createHarness({ A: { loudnessDb: -20, bpm: 120, nextBeatIn: 0.1 } });
        harness.arm();

        harness.session.handleActiveDeckPlaying('local:next-song');

        // Beats every half second from 0.1s in. At -20dBFS the handover sits at 42.5% of the
        // blend, so the length moves until that lands on the beat at 2.1s.
        expect(lastCurve(harness.chains.A.fadeNode)?.duration).toBeCloseTo(2.1 / 0.425, 5);
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

    it('keeps the role on the loading deck when the outgoing track runs out first', () => {
        const harness = createHarness();
        harness.arm();

        harness.session.handleTailEnded();

        expect(harness.session.getPhase()).toBe('idle');
        // Handing the role back here is what used to leave the app silent: audioSrc is already on
        // its way to this deck and the audio bridge has already aimed play() at it, so moving the
        // role would drop the next track onto an element nothing is going to start.
        expect(harness.session.getActiveDeck()).toBe('B');
        expect(harness.activeDeckChanges).toEqual(['B']);
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

    it('ends the transition when playback is paused while armed', () => {
        const harness = createHarness();
        harness.arm();

        // True tells the caller the in-flight advance still has to have its autoplay suppressed.
        expect(harness.session.abort()).toBe(true);

        expect(harness.session.getPhase()).toBe('idle');
        expect(harness.session.getActiveDeck()).toBe('B');
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

    it('sets the blend length in beats of the outgoing track rather than in seconds', () => {
        // 90 BPM: eight beats is 5.33s, where a fixed five seconds would be five.
        const harness = createHarness({ A: { bpm: 90 } });

        const plan = harness.arm({
            from: { duration: 100, lines: [] },
            to: { duration: 100, lines: [] },
        });

        expect(plan?.overlap).toBeCloseTo(60 / 90 * 8, 2);
        expect(plan?.reason).toContain('8 beats');
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

describe('automix session, transition styles', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.spyOn(console, 'log').mockImplementation(() => { });
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    const profile = (overrides: Partial<TrackProfile> = {}): TrackProfile => ({
        version: TRACK_PROFILE_VERSION,
        partial: false,
        duration: 100,
        leadIn: 0,
        leadOut: 0,
        startsHot: false,
        endsHot: false,
        introSlope: 0,
        outroSlope: 0,
        loudness: -14,
        bpm: 120,
        beatOffset: 0,
        key: -1,
        major: true,
        keyConfidence: 0,
        ...overrides,
    });

    it('takes the low end off the arriving track and gives it back at the handover', () => {
        // The one thing two overlapping tracks cannot share. Everything below ~250Hz doubles in
        // level, beats against itself and cancels; the mids overlap perfectly happily.
        const harness = createHarness({ A: { loudnessDb: -20 } });
        harness.arm({
            from: { ...BLENDABLE_FROM, profile: profile({ outroSlope: -3 }) },
            to: { ...BLENDABLE_TO, profile: profile({ leadIn: 2 }) },
        });

        harness.session.handleActiveDeckPlaying('local:next-song');

        // The arriving deck opens filtered and ends open; the leaving deck does the opposite.
        expect(finalTarget(harness.chains.B.lowCutParam)).toBe(20);
        expect(harness.chains.B.lowCutParam.events[1]).toMatchObject({ type: 'set', value: 250 });
        expect(finalTarget(harness.chains.A.lowCutParam)).toBe(250);
        expect(harness.chains.A.lowCutParam.events[1]).toMatchObject({ type: 'set', value: 20 });
    });

    it('opens the low cut on both decks again when the transition settles', () => {
        const harness = createHarness();
        harness.arm({
            from: { ...BLENDABLE_FROM, profile: profile({ outroSlope: -3 }) },
            to: { ...BLENDABLE_TO, profile: profile({ leadIn: 2 }) },
        });
        harness.session.handleActiveDeckPlaying('local:next-song');

        vi.advanceTimersByTime(9_000);

        // A deck left filtered would come back thin the next time it is used - the same failure
        // mode the trim reset exists for.
        expect(finalTarget(harness.chains.A.lowCutParam)).toBe(20);
        expect(finalTarget(harness.chains.B.lowCutParam)).toBe(20);
    });

    it('waits out the outgoing track and splices, for a segue the album already had', () => {
        const harness = createHarness();
        const plan = harness.arm({
            time: 99,
            sameAlbum: true,
            from: { ...BLENDABLE_FROM, profile: profile({ endsHot: true }) },
            to: { ...BLENDABLE_TO, profile: profile({ startsHot: true, leadIn: 3 }) },
        });
        expect(plan?.style).toBe('gapless');

        harness.session.handleActiveDeckPlaying('local:next-song');

        // Five seconds of the outgoing track are left, so the incoming deck - which has already
        // started, silently - waits all but the splice out. It costs nothing here because the
        // incoming track opens with three seconds of silence to spend.
        const splice = lastCurve(harness.chains.A.fadeNode);
        expect(splice?.duration).toBeCloseTo(0.006, 4);
        expect(splice?.time).toBeCloseTo(1.494, 3);
        expect(harness.chains.A.lowCutParam.events).toHaveLength(0);
    });

    it('overlaps instead when a splice would eat the start of the next track', () => {
        const harness = createHarness();
        harness.arm({
            time: 99,
            sameAlbum: true,
            from: { ...BLENDABLE_FROM, profile: profile({ endsHot: true }) },
            to: { ...BLENDABLE_TO, profile: profile({ startsHot: true, leadIn: 0 }) },
        });

        harness.session.handleActiveDeckPlaying('local:next-song');

        // No leading silence to wait in, so the join would have to cut into the first notes.
        expect(lastCurve(harness.chains.A.fadeNode)?.duration).toBeGreaterThan(1);
        expect(finalTarget(harness.chains.A.lowCutParam)).toBe(250);
    });

    it('cuts rather than fades into a track that starts at full level', () => {
        const harness = createHarness();
        const plan = harness.arm({
            time: 99,
            from: { ...BLENDABLE_FROM, profile: profile({ bpm: 120 }) },
            // A beat of leading silence: at 120 BPM that is the half second the cut needs to be
            // placeable. Without it the chooser keeps a short overlap instead.
            to: { ...BLENDABLE_TO, profile: profile({ startsHot: true, leadIn: 0.8 }) },
        });
        expect(plan?.style).toBe('beatCut');

        harness.session.handleActiveDeckPlaying('local:next-song');

        expect(lastCurve(harness.chains.A.fadeNode)?.duration).toBeCloseTo(0.04, 4);
    });

    it('leaves an unanalysed pair on the plain crossfade it always had', () => {
        const harness = createHarness();
        const plan = harness.arm();

        expect(plan?.style).toBe('plainBlend');
        harness.session.handleActiveDeckPlaying('local:next-song');
        expect(harness.chains.A.lowCutParam.events).toHaveLength(0);
    });
});
