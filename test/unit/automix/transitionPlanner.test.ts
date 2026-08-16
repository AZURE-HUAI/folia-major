import { describe, expect, it } from 'vitest';
import type { Line } from '../../../src/types';
import { isInterludeLine, parseLRC } from '../../../src/utils/lyrics/parserCore';
import {
    AUTOMIX_DEFAULT_OVERLAP_SEC,
    AUTOMIX_MAX_OVERLAP_SEC,
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

    it('does not read the credit block at 0:00 as the first sung moment', () => {
        // Built through the real parser: online lyric files open with "作词 : X" stamped at 0:00,
        // and counting that as singing reported a zero-second intro for very nearly every track -
        // which threw away the vocal-free window on all of them and left every blend on the
        // beat-count fallback. Observed in the app as "every transition is the last two seconds".
        const incoming = parseLRC(
            '[00:00.000]作词 : 老番茄\n[00:00.000]作曲 : 老番茄\n'
            + '[00:12.00]first sung line\n[00:20.00]second line',
        );

        const plan = planTransition(track(100, [line(10, 60)]), track(100, incoming.lines));

        expect(plan.overlap).toBe(AUTOMIX_MAX_OVERLAP_SEC);
        expect(plan.reason).toContain('intro 12s');
    });

    it('recognises the credit block by its shape, not by anyone\'s list of role names', () => {
        // Whatever the words are, in whatever language: stamped at zero, with the song starting
        // later. A list of role names would be one file format's list and wrong for the next.
        const plan = planTransition(
            track(100, [line(10, 60)]),
            track(100, [line(0, 0, 'Produced by Someone'), line(0, 0, '제작'), line(9, 40, 'sung')]),
        );
        expect(plan.reason).toContain('intro 9s');
    });

    it('reads a credit block as credits however soon the singing starts', () => {
        // Two lines sharing one timestamp is proof by itself - nothing sings both at that instant -
        // so a silence after them is not also required. Demanding one read a zero-second intro for
        // every track whose first line happens to land inside the first few seconds, which is most
        // of them, and that is what kept the vocal-free window unusable in the app.
        const plan = planTransition(
            track(100, [line(10, 60)]),
            track(100, [line(0, 0, '作词 : X'), line(0, 0, '作曲 : Y'), line(1.5, 40, 'sung')]),
        );
        expect(plan.reason).toContain('intro 1.5s');
    });

    it('keeps a timeline that genuinely opens on a lyric', () => {
        // A line at zero followed straight away by more singing was singing, not a credit.
        const plan = planTransition(
            track(100, [line(10, 90)]),
            track(100, [line(0, 2, 'cold open'), line(2.5, 40, 'and on it goes')]),
        );
        expect(plan.reason).toContain('intro 0s');
    });

    it('blends at the default length when a lyric timeline is missing', () => {
        // Local files, instrumentals, tracks whose lyrics failed to fetch: all still blend.
        const plan = planTransition(track(100, null), track(100, [line(10, 90)]));
        expect(plan.kind).toBe('fade');
        expect(plan.overlap).toBe(AUTOMIX_DEFAULT_OVERLAP_SEC);
        expect(plan.reason).toContain('no lyrics for the outgoing track');
    });

    it('says so when a lyric file exists but holds nothing sung', () => {
        // An instrumental interlude blends exactly like a track with no lyrics at all, but the two
        // mean different things when the question is why no vocal-free window could be proven.
        const plan = planTransition(track(100, [line(10, 90)]), track(100, [line(0, 4, '   ')]));
        expect(plan.reason).toContain('nothing sung in the incoming lyrics');
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

    it('measures the default blend in beats once a tempo is known', () => {
        // Five seconds is two bars of a ballad and nearly four of a fast track, so the same
        // number reads as leisurely on one song and frantic on the next. Eight beats does not.
        expect(planTransition(track(100, null), track(100, null), 90).overlap).toBeCloseTo(5.33, 2);
        expect(planTransition(track(100, null), track(100, null), 160).overlap).toBeCloseTo(3, 2);
    });

    it('trims a proven vocal-free window back to whole beats', () => {
        // The gap is 6s; at 95 BPM that is nine beats and a half, so the blend takes the nine.
        const plan = planTransition(track(100, [line(10, 94)]), track(100, [line(6, 90)]), 95);
        expect(plan.overlap).toBeCloseTo(9 * 60 / 95, 2);
    });

    it('still caps a beat-derived length at the ceiling', () => {
        // Eight beats of a very slow track would run to eleven seconds.
        expect(planTransition(track(200, null), track(100, null), 45).overlap)
            .toBe(AUTOMIX_MAX_OVERLAP_SEC);
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
