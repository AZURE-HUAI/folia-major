import { describe, expect, it } from 'vitest';
import {
    BEAT_CUT_SEC,
    chooseTransitionStyle,
    GAPLESS_SPLICE_SEC,
    keyRelation,
    shapeBlend,
} from '@/services/automix/transitionChooser';
import { TRACK_PROFILE_VERSION, type TrackProfile } from '@/services/automix/trackProfile';

// test/unit/automix/transitionChooser.test.ts

const profile = (overrides: Partial<TrackProfile> = {}): TrackProfile => ({
    version: TRACK_PROFILE_VERSION,
    partial: false,
    duration: 200,
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

const inKey = (key: number, major: boolean) => profile({ key, major, keyConfidence: 0.8 });

describe('keyRelation', () => {
    it('reads the circle of fifths and the relative minor as compatible', () => {
        expect(keyRelation(inKey(0, true), inKey(0, true))).toBe('compatible');   // C  -> C
        expect(keyRelation(inKey(0, true), inKey(7, true))).toBe('compatible');   // C  -> G
        expect(keyRelation(inKey(0, true), inKey(5, true))).toBe('compatible');   // C  -> F
        expect(keyRelation(inKey(0, true), inKey(9, false))).toBe('compatible');  // C  -> Am
        expect(keyRelation(inKey(9, false), inKey(0, true))).toBe('compatible');  // Am -> C
    });

    it('calls a semitone and a tritone a clash', () => {
        expect(keyRelation(inKey(0, true), inKey(1, true))).toBe('clashing');
        expect(keyRelation(inKey(0, true), inKey(11, true))).toBe('clashing');
        expect(keyRelation(inKey(0, true), inKey(6, true))).toBe('clashing');
    });

    it('leaves everything else alone rather than inventing a grade for it', () => {
        expect(keyRelation(inKey(0, true), inKey(2, true))).toBe('neutral');
    });

    it('treats a low-confidence estimate as no answer', () => {
        // Key detection on a full mix is right about three times in four. Acting on the quarter
        // where it is wrong would shorten blends that had nothing wrong with them.
        expect(keyRelation(inKey(0, true), profile({ key: 6, keyConfidence: 0.05 }))).toBe('unknown');
        expect(keyRelation(inKey(0, true), null)).toBe('unknown');
    });
});

describe('chooseTransitionStyle', () => {
    it('joins consecutive album tracks that run into each other', () => {
        const choice = chooseTransitionStyle({
            from: profile({ endsHot: true }),
            to: profile({ startsHot: true }),
            sameAlbum: true,
        });
        expect(choice.style).toBe('gapless');
    });

    it('does not join two unrelated songs just because both ends are loud', () => {
        // The old vetoed rule refused to blend album-mates at all. This one only reaches for a
        // different join when the album says the segue may have been written in.
        const choice = chooseTransitionStyle({
            from: profile({ endsHot: true }),
            to: profile({ startsHot: true }),
            sameAlbum: false,
        });
        expect(choice.style).not.toBe('gapless');
    });

    it('cuts into a hot start only when there is a beat of silence to place the cut in', () => {
        // 120 BPM = half a second a beat, and the wait can only be paid for out of the incoming
        // track's own leading silence.
        const choice = chooseTransitionStyle({
            from: profile({ bpm: 120 }),
            to: profile({ startsHot: true, leadIn: 0.8 }),
            sameAlbum: false,
        });
        expect(choice.style).toBe('beatCut');
    });

    it('shortens the overlap instead of chopping when the cut cannot be placed', () => {
        // Every transition in a real playlist came out as a 40ms cut once, because a hot start was
        // taken as licence to cut whether or not the cut could land anywhere musical. An
        // unplaceable cut is not a transition - it is the feature appearing to be switched off.
        const choice = chooseTransitionStyle({
            from: profile({ bpm: 120 }),
            to: profile({ startsHot: true, leadIn: 0.07 }),
            sameAlbum: false,
        });
        expect(choice.style).toBe('bassSwap');
        expect(choice.lengthScale).toBeLessThan(1);
        expect(choice.lengthScale).toBeGreaterThan(0);
    });

    it('swaps the low end under a track that fades itself out', () => {
        const choice = chooseTransitionStyle({
            from: profile({ outroSlope: -3 }),
            to: profile({ leadIn: 2 }),
            sameAlbum: false,
        });
        expect(choice.style).toBe('bassSwap');
    });

    it('rides a decaying tail when the next track has an intro to come up through it', () => {
        const choice = chooseTransitionStyle({
            from: profile({ endsHot: false, outroSlope: -0.5 }),
            to: profile({ leadIn: 1.5 }),
            sameAlbum: false,
        });
        expect(choice.style).toBe('tailRide');
        expect(choice.lengthScale).toBeGreaterThan(1);
    });

    it('falls back to a plain crossfade only when nothing was measured', () => {
        // This used to be every transition there was. It should now be the rarest one.
        expect(chooseTransitionStyle({ from: null, to: null, sameAlbum: false }).style).toBe('plainBlend');
        expect(chooseTransitionStyle({ from: profile(), to: null, sameAlbum: false }).style).toBe('bassSwap');
    });

    it('still cuts into a hot start when only the heads of both tracks were readable', () => {
        // Song caching off: all we could read is the front of each file. Both halves of the cut
        // rule are head-side, so this is the case that has to keep working.
        const head = (overrides: Partial<TrackProfile> = {}) =>
            profile({ partial: true, leadOut: null, endsHot: null, outroSlope: null, ...overrides });

        const choice = chooseTransitionStyle({
            from: head({ bpm: 128 }),
            to: head({ startsHot: true, leadIn: 1 }),
            sameAlbum: false,
        });
        expect(choice.style).toBe('beatCut');
    });

    it('does not read an unknown tail as a known one', () => {
        // null means "not knowable without downloading the file". Treating it as false would pick
        // tailRide for tracks that end dead flat, and gapless is simply not decidable at all.
        const head = profile({ partial: true, leadOut: null, endsHot: null, outroSlope: null });

        expect(chooseTransitionStyle({ from: head, to: profile({ startsHot: true }), sameAlbum: true }).style)
            .not.toBe('gapless');
        expect(chooseTransitionStyle({ from: head, to: profile({ leadIn: 2, bpm: null }), sameAlbum: false }).style)
            .toBe('bassSwap');
    });

    it('shortens an overlap between clashing keys instead of trying to fix it', () => {
        const clash = chooseTransitionStyle({ from: inKey(0, true), to: inKey(6, true), sameAlbum: false });
        const fits = chooseTransitionStyle({ from: inKey(0, true), to: inKey(7, true), sameAlbum: false });
        expect(clash.lengthScale).toBeLessThan(fits.lengthScale);
    });
});

describe('shapeBlend', () => {
    const base = {
        room: 1.5,
        overlap: 4,
        crossover: 0.4,
        nextBeatIn: null,
        periodSec: null,
        incomingLeadIn: null,
    };

    it('waits out the rest of the outgoing track before a gapless splice', () => {
        const shape = shapeBlend({ ...base, style: 'gapless', incomingLeadIn: 3 });
        expect(shape.style).toBe('gapless');
        expect(shape.hold).toBeCloseTo(1.5 - GAPLESS_SPLICE_SEC, 4);
        expect(shape.overlap).toBe(GAPLESS_SPLICE_SEC);
    });

    it('gives up the splice rather than swallowing the start of the next track', () => {
        // Waiting is the only way to place a join, and anything waited past the incoming track's
        // own silence comes out of its first notes. A missing downbeat is worse than an overlap.
        const shape = shapeBlend({ ...base, style: 'gapless', incomingLeadIn: 0 });
        expect(shape.style).toBe('bassSwap');
        expect(shape.hold).toBe(0);
        expect(shape.overlap).toBe(4);
    });

    it('cuts on the spot when there is no beat it can afford to wait for', () => {
        const shape = shapeBlend({
            ...base, style: 'beatCut', nextBeatIn: 0.3, periodSec: 0.5, incomingLeadIn: 0,
        });
        expect(shape.hold).toBe(0);
        expect(shape.overlap).toBe(BEAT_CUT_SEC);
        expect(shape.bassSwap).toBe(false);
    });

    it('takes the latest beat that fits inside the next track\'s own silence', () => {
        const shape = shapeBlend({
            ...base, style: 'beatCut', nextBeatIn: 0.2, periodSec: 0.5, incomingLeadIn: 1,
        });
        expect(shape.hold).toBeCloseTo(0.7, 6);
    });

    it('leaves an overlapping style alone, and only swaps bass where a swap makes sense', () => {
        expect(shapeBlend({ ...base, style: 'bassSwap' })).toMatchObject({ hold: 0, overlap: 4, bassSwap: true });
        expect(shapeBlend({ ...base, style: 'tailRide' })).toMatchObject({ bassSwap: true });
        expect(shapeBlend({ ...base, style: 'plainBlend' })).toMatchObject({ bassSwap: false });
    });
});
