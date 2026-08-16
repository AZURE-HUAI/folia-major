import { describe, expect, it } from 'vitest';
import type { Line } from '../../../src/types';
import { isInterludeLine, parseLRC } from '../../../src/utils/lyrics/parserCore';
import {
    AUTOMIX_DEFAULT_OVERLAP_SEC,
    AUTOMIX_MAX_OVERLAP_SEC,
    equalPowerGains,
    planTransition,
    resolveOverlap,
    type TransitionTrack,
} from '../../../src/services/automix/transitionPlanner';

const line = (startTime: number, endTime: number, fullText = 'la'): Line => ({
    words: [], startTime, endTime, fullText,
});

const track = (duration: number, lines: Line[] | null): TransitionTrack => ({ duration, lines });

describe('planTransition', () => {
    it('overlaps only the vocal-free outro and intro', () => {
        // outro = 100 - 94 = 6s, intro = 4s -> the smaller one bounds the blend
        const plan = planTransition(track(100, [line(10, 94)]), track(100, [line(4, 90)]));
        expect(plan.kind).toBe('fade');
        expect(plan.overlap).toBe(4);
        expect(plan.outStart).toBe(96);
        expect(plan.inStart).toBe(0);
    });

    it('caps the overlap so a long outro does not swallow the next song', () => {
        const plan = planTransition(track(100, [line(10, 70)]), track(100, [line(30, 90)]));
        expect(plan.overlap).toBe(AUTOMIX_MAX_OVERLAP_SEC);
    });

    it('still blends at the default length when the vocals leave no gap', () => {
        // Two songs that sing end to end. Placing the blend well is impossible here, but the
        // listener asked for blended song changes, so it blends anyway rather than quietly cutting.
        const plan = planTransition(track(100, [line(10, 99.8)]), track(100, [line(0.1, 90)]));
        expect(plan.kind).toBe('fade');
        expect(plan.overlap).toBe(AUTOMIX_DEFAULT_OVERLAP_SEC);
        expect(plan.reason).toContain('default');
    });

    it('blends two tracks off one album like any other pair', () => {
        // Album continuity used to veto this. The switch is the listener's answer to that question.
        const plan = planTransition(track(100, [line(10, 90)]), track(100, [line(10, 90)]));
        expect(plan.kind).toBe('fade');
        expect(plan.overlap).toBeGreaterThan(0);
    });

    it('ignores blank interlude lines when locating the last sung moment', () => {
        // a trailing placeholder line must not read as singing, or the outro collapses to 5s
        const plan = planTransition(track(100, [line(10, 20), line(90, 95, '   ')]), track(100, [line(30, 90)]));
        expect(plan.overlap).toBe(AUTOMIX_MAX_OVERLAP_SEC);
    });

    it('does not read the parser\'s own interlude placeholder as singing', () => {
        // Built through the real parser rather than by hand: attachInterludes prepends a '......'
        // line at 0.5s to every track that starts singing after 0:03. Counting that as a voice
        // reported a half-second intro for almost every song and refused every blend there is.
        const incoming = parseLRC('[00:12.00]first sung line\n[00:20.00]second line');
        expect(isInterludeLine(incoming.lines[0])).toBe(true);

        const plan = planTransition(track(100, [line(10, 60)]), track(100, incoming.lines));
        expect(plan.kind).toBe('fade');
        expect(plan.overlap).toBe(AUTOMIX_MAX_OVERLAP_SEC);
    });

    it('blends at the default length when a lyric timeline is missing', () => {
        // Local files, instrumentals, tracks whose lyrics failed to fetch: all still blend.
        const plan = planTransition(track(100, null), track(100, [line(10, 90)]));
        expect(plan.kind).toBe('fade');
        expect(plan.overlap).toBe(AUTOMIX_DEFAULT_OVERLAP_SEC);
        expect(plan.reason).toContain('no lyric timeline on outgoing');
    });

    it('keeps the blend under a quarter of a very short track', () => {
        const plan = planTransition(track(12, null), track(100, null));
        expect(plan.kind).toBe('fade');
        expect(plan.overlap).toBe(3);
    });

    it('cuts only when the track is too short to fade across at all', () => {
        const plan = planTransition(track(2, null), track(100, null));
        expect(plan.kind).toBe('hardCut');
        expect(plan.reason).toContain('too short');
    });

    it('cuts when the outgoing duration is unknown', () => {
        expect(planTransition(track(NaN, [line(10, 90)]), track(100, [line(10, 90)])).kind).toBe('hardCut');
    });
});

describe('resolveOverlap', () => {
    const fadePlan = planTransition(track(100, [line(10, 94)]), track(100, [line(6, 90)]));

    it('keeps the planned overlap when the track still has the room', () => {
        expect(fadePlan.overlap).toBe(6);
        expect(resolveOverlap(fadePlan, 10)).toBe(6);
    });

    it('shrinks to the time actually left when the incoming track was slow to load', () => {
        expect(resolveOverlap(fadePlan, 3.5)).toBe(3.5);
    });

    it('gives up rather than fading over a window that no longer exists', () => {
        expect(resolveOverlap(fadePlan, 0.4)).toBe(0);
    });

    it('never blends for a plan that was not a blend', () => {
        const cut = planTransition(track(NaN, [line(10, 90)]), track(100, [line(10, 90)]));
        expect(cut.kind).toBe('hardCut');
        expect(resolveOverlap(cut, 30)).toBe(0);
    });

    it('treats an unreadable remaining time as no room at all', () => {
        expect(resolveOverlap(fadePlan, NaN)).toBe(0);
    });
});

describe('equalPowerGains', () => {
    it('holds constant power across the blend instead of dipping at the midpoint', () => {
        for (const progress of [0, 0.25, 0.5, 0.75, 1]) {
            const { out, in: incoming } = equalPowerGains(progress);
            expect(out ** 2 + incoming ** 2).toBeCloseTo(1, 6);
        }
    });

    it('clamps out-of-range progress', () => {
        expect(equalPowerGains(-1).out).toBe(1);
        expect(equalPowerGains(2).in).toBe(1);
    });
});
