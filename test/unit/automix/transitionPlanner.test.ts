import { describe, expect, it } from 'vitest';
import type { Line } from '../../../src/types';
import { isInterludeLine, parseLRC } from '../../../src/utils/lyrics/parserCore';
import {
    AUTOMIX_DEFAULT_OVERLAP_SEC,
    AUTOMIX_MAX_OVERLAP_SEC,
    AUTOMIX_MIN_OVERLAP_SEC,
    planTransition,
    resolveOverlap,
    type TransitionTrack,
} from '../../../src/services/automix/transitionPlanner';
import { BEAT_CUT_SEC, shapeBlend } from '../../../src/services/automix/transitionChooser';
import { makeProfile } from './trackProfileFixture';

const line = (startTime: number, endTime: number, fullText = 'la'): Line => ({
    words: [], startTime, endTime, fullText,
});

/**
 * The two ends come from two different places now, and the signature says so.
 *
 * `lines` decides the OUTGOING side - where the singing stopped. `intro` decides the INCOMING
 * side and is measured off the audio, so it arrives on the profile: omit it for a track that was
 * never analysed, pass null for one that was analysed but yielded no boundary.
 */
const track = (duration: number, lines: Line[] | null, intro?: number | null): TransitionTrack => ({
    duration,
    lines,
    profile: intro === undefined ? null : makeProfile({ sectionStart: intro }),
});

describe('planTransition', () => {
    it('overlaps only the vocal-free outro and intro', () => {
        // outro = 100 - 94 = 6s, intro = 4s -> the smaller one bounds the blend
        const plan = planTransition(track(100, [line(10, 94)]), track(100, null, 4));
        expect(plan.kind).toBe('fade');
        expect(plan.overlap).toBe(4);
        expect(plan.outStart).toBe(96);
        expect(plan.inStart).toBe(0);
    });

    it('does not stretch a blend just because the gap is generous', () => {
        // A 30s outro into a 30s intro is room, not an instruction. Spending it produced the
        // eight-second crossfade that reads as "the app is just fading" - the length comes from
        // the default, and the window is only ever allowed to shorten it.
        const plan = planTransition(track(100, [line(10, 70)]), track(100, null, 30));
        expect(plan.overlap).toBe(AUTOMIX_DEFAULT_OVERLAP_SEC);
        expect(plan.reason).not.toContain('capped by');
    });

    it('keeps a fast track to a phrase rather than the ceiling', () => {
        // The bug as heard: 185 BPM, a 26s outro into an 11s intro, and the blend took the whole
        // eight-second cap - twenty-three beats, long past where two songs still sound like two.
        const plan = planTransition(track(200, [line(10, 173.66)]), track(200, null, 11), 185);
        expect(plan.overlap).toBeCloseTo(8 * 60 / 185, 2);
        expect(plan.overlap).toBeLessThan(AUTOMIX_MAX_OVERLAP_SEC);
    });

    it('still blends at the default length when the vocals leave no gap', () => {
        // Two songs that sing end to end. Placing the blend well is impossible here, but the
        // listener asked for blended song changes, so it blends anyway rather than quietly cutting.
        const plan = planTransition(track(100, [line(10, 99.8)]), track(100, null, 0.1));
        expect(plan.kind).toBe('fade');
        expect(plan.overlap).toBe(AUTOMIX_DEFAULT_OVERLAP_SEC);
        expect(plan.reason).toContain('default');
    });

    it('blends two tracks off one album like any other pair', () => {
        // Album continuity used to veto this. The switch is the listener's answer to that question.
        const plan = planTransition(track(100, [line(10, 90)]), track(100, null, 10));
        expect(plan.kind).toBe('fade');
        expect(plan.overlap).toBeGreaterThan(0);
    });

    it('takes the intro from the audio, so a credit block cannot report a zero-second one', () => {
        // Every online lyric source opens with a credit block and the three of them format it
        // three incompatible ways - QQ at 0/1/2s, Kugou spread evenly across the whole intro and
        // flush against the first sung line, NetEase all stacked on 0.000. Reading "the first
        // line" as "the first sung moment" gave an intro of zero on nearly every online track and
        // no timing rule can separate the three. The lyric file no longer gets asked.
        const creditBlock = [line(0, 1, '作词：someone'), line(1, 2, '作曲：someone'), line(9.81, 12, 'sung')];
        const plan = planTransition(track(100, [line(10, 80)]), track(100, creditBlock, 9.81));
        expect(plan.reason).toContain('intro 9.81s');
    });

    it('ignores blank interlude lines when locating the last sung moment', () => {
        // a trailing placeholder line must not read as singing, or the outro collapses to 5s
        const plan = planTransition(track(100, [line(10, 20), line(90, 95, '   ')]), track(100, null, 30));
        expect(plan.reason).toContain('outro 80s');
    });

    it('does not read the parser\'s own interlude placeholder as singing', () => {
        // Built through the real parser rather than by hand, and that matters: attachInterludes
        // inserts '......' lines the hand-built fixtures above have no idea about. Reading one as
        // a voice once vetoed every blend in the app while every unit test passed.
        const outgoing = parseLRC('[00:12.00]first sung line\n[00:20.00]last sung line');
        expect(isInterludeLine(outgoing.lines[0])).toBe(true);

        const plan = planTransition(track(100, outgoing.lines), track(100, null, 30));
        expect(plan.kind).toBe('fade');
        expect(plan.reason).toContain('outro 75s');
    });

    it('blends at the default length when a lyric timeline is missing', () => {
        // Local files, instrumentals, tracks whose lyrics failed to fetch: all still blend.
        const plan = planTransition(track(100, null), track(100, null, 10));
        expect(plan.kind).toBe('fade');
        expect(plan.overlap).toBe(AUTOMIX_DEFAULT_OVERLAP_SEC);
        expect(plan.reason).toContain('no lyrics for the outgoing track');
    });

    it('separates a track nobody analysed from one with no voice in it', () => {
        // Both blend the same way; they are different answers to "why was there no window", and
        // one of them is a bug report waiting to happen while the other is an instrumental.
        expect(planTransition(track(100, [line(10, 90)]), track(100, null)).reason)
            .toContain('the incoming track was never analysed');
        expect(planTransition(track(100, [line(10, 90)]), track(100, null, null)).reason)
            .toContain('nothing measurable at the start of the incoming track');
    });

    it('says so when a lyric file exists but holds nothing sung', () => {
        // An instrumental interlude blends exactly like a track with no lyrics at all, but the two
        // mean different things when the question is why no vocal-free window could be proven.
        const plan = planTransition(track(100, [line(0, 4, '   ')]), track(100, null, 10));
        expect(plan.reason).toContain('nothing sung in the outgoing lyrics');
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
        // A 3s gap is narrower than the eight beats wanted, so it binds - and at 95 BPM it is four
        // beats and three quarters, so the blend takes the four rather than ending mid-pulse.
        const plan = planTransition(track(100, [line(10, 97)]), track(100, null, 3), 95);
        expect(plan.overlap).toBeCloseTo(4 * 60 / 95, 2);
        expect(plan.reason).toContain('capped by the vocal-free window');
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
    const fadePlan = planTransition(track(100, [line(10, 94)]), track(100, null, 6));

    it('keeps the planned overlap when the track still has the room', () => {
        expect(fadePlan.overlap).toBe(5);
        expect(resolveOverlap(fadePlan, 10)).toBe(5);
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

/**
 * The handoff between deciding a join and performing it.
 *
 * Both halves read correctly on their own and still disagreed between them: the planner asked for
 * a second and a half of room, and the shaper refuses to wait longer than the incoming track's own
 * leading silence, which on a commercial master is a fraction of that. So the planner asks for
 * what can actually be waited out, and these check the two ends still agree.
 */
describe('a join has to survive the step that performs it', () => {
    const runTogether = (leadIn: number) => ({
        from: {
            duration: 200,
            lines: null,
            profile: makeProfile({ endsHot: true }),
        },
        to: {
            duration: 200,
            lines: null,
            profile: makeProfile({ startsHot: true, leadIn }),
        },
    });

    /** What automixSession does at the instant the incoming deck starts. */
    const perform = (
        plan: ReturnType<typeof planTransition>,
        incomingLeadIn: number,
        grid: { nextBeatIn: number | null; periodSec: number | null } = { nextBeatIn: null, periodSec: null },
    ) => shapeBlend({
        style: plan.style,
        room: plan.overlap,
        overlap: plan.overlap,
        crossover: 0.5,
        ...grid,
        incomingLeadIn,
    });

    it('gives two tracks that run into each other something the listener can hear', () => {
        // These used to get a six-millisecond splice, on the grounds that the record already joins
        // them. It does - and a listener who switched blending on heard nothing happen, on two
        // thirds of the song changes of a continuous album. Every style left is an audible one.
        const { from, to } = runTogether(0.3);
        const plan = planTransition(from, to, 120);

        expect(plan.overlap).toBeGreaterThanOrEqual(AUTOMIX_MIN_OVERLAP_SEC);
        expect(perform(plan, 0.3).overlap).toBe(plan.overlap);
    });

    it('places a cut on a beat the incoming track can afford to wait for', () => {
        // 120 BPM is half a second a beat, and the wait comes out of the next track's own silence.
        const { from, to } = runTogether(0.8);
        const plan = planTransition(from, to, 120);
        expect(plan.style).toBe('beatCut');
        // Not CUT_LEAD_SEC: the room asked for is what the wait can actually be paid for.
        expect(plan.overlap).toBeLessThanOrEqual(0.85);

        const shaped = perform(plan, 0.8, { nextBeatIn: 0.2, periodSec: 0.5 });
        expect(shaped.style).toBe('beatCut');
        expect(shaped.hold).toBeCloseTo(0.7, 6);
        expect(shaped.overlap).toBe(BEAT_CUT_SEC);
    });
});
