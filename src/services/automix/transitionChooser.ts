import type { TrackProfile } from './trackProfile';

// src/services/automix/transitionChooser.ts
// Which KIND of transition two songs should get, and what that kind turns into on the audio clock.
// Pure - profiles and numbers in, a description of a schedule out.
//
// The reason this file exists: for as long as there was only one transition, every song change was
// a crossfade and the only thing left to decide was how long. A crossfade is the right answer for
// maybe a third of song changes and the least wrong answer for the rest, which is what "it leans
// on fading too much" describes. Five kinds and a chooser is the fix; a better curve is not.

export type TransitionStyle =
    /** Author-intended segue: the two tracks are simply joined, with a splice too short to hear. */
    | 'gapless'
    /** The incoming track starts at full tilt, so the outgoing one is cut rather than faded. */
    | 'beatCut'
    /** Overlapped, but only one track holds the low end at a time. The default when two overlap. */
    | 'bassSwap'
    /** A long overlap that lifts the incoming track out from under a decaying tail. */
    | 'tailRide'
    /** A plain crossfade. What everything used to be; now only what is left when nothing is known. */
    | 'plainBlend';

export type KeyRelation = 'compatible' | 'neutral' | 'clashing' | 'unknown';

/** Below this the key estimate is a coin flip and is treated as no answer at all. */
export const MIN_KEY_CONFIDENCE = 0.25;
/** Steeper than this over the last ten seconds is a produced fade-out, not a musical ending. */
const FADE_OUT_SLOPE_DB_PER_SEC = -1.5;
/** A lead-in shorter than this is not an intro, it is the file's own leading silence. */
const INTRO_SILENCE_SEC = 0.3;

/** Splice length for a gapless join: short enough to be inaudible, long enough not to click. */
export const GAPLESS_SPLICE_SEC = 0.006;
/** A cut is not instant either - a step in the waveform is a click on every system. */
export const BEAT_CUT_SEC = 0.04;
/** How much of the outgoing track a gapless join is allowed to occupy while it waits. */
export const GAPLESS_LEAD_SEC = 1.5;
/** The same for a cut, and it is spent: whatever is not waited out is cut off. */
export const CUT_LEAD_SEC = 1.5;
/**
 * How much of the incoming track's own beginning may be swallowed while waiting.
 *
 * Waiting is the only way to place a handover, because the incoming deck starts when the media
 * element manages to start and not when we ask. Anything waited beyond the incoming track's own
 * leading silence comes out of its first notes, and a missing downbeat is far more audible than a
 * handover landing slightly off the grid - so the budget is tight.
 */
const HEAD_BUDGET_SEC = 0.05;

/** Length multipliers by how well the two keys sit together. Unknown must not be a penalty. */
const LENGTH_SCALE: Record<KeyRelation, number> = {
    compatible: 1,
    neutral: 0.7,
    clashing: 0.4,
    unknown: 1,
};

/**
 * How much shorter an overlap gets when the incoming track opens at full level.
 *
 * A track with no intro gives the blend nothing to hide under, so the overlap wants to be brief -
 * but brief is not the same as absent, and this is the number that says so.
 */
const HOT_START_SCALE = 0.6;

/** Longer for a style that wants room, shorter for one that wants none. */
const STYLE_SCALE: Record<TransitionStyle, number> = {
    gapless: 1,
    beatCut: 1,
    bassSwap: 1,
    tailRide: 1.4,
    plainBlend: 1,
};

const usableKey = (profile: TrackProfile | null | undefined) => (
    profile && profile.key >= 0 && profile.keyConfidence >= MIN_KEY_CONFIDENCE ? profile : null
);

/**
 * How two keys sit together, in the only three grades that change what we do.
 *
 * Used to pick a transition, never to modify one. Bending the outgoing track's pitch onto the
 * incoming one is the obvious-looking move and it is wrong twice over: playbackRate shifts tempo
 * with pitch (a semitone is a 5.9% speed change, which reads as a tape stop), and a hand-rolled
 * phase vocoder on a finished mix smears the transients worse than the dissonance it removes. A
 * clash is answered by not giving it time, which costs nothing.
 */
export const keyRelation = (
    from: TrackProfile | null | undefined,
    to: TrackProfile | null | undefined,
): KeyRelation => {
    const a = usableKey(from);
    const b = usableKey(to);
    if (!a || !b) return 'unknown';

    const interval = ((b.key - a.key) % 12 + 12) % 12;
    if (a.major === b.major) {
        // Same key, or one step either way round the circle of fifths.
        if (interval === 0 || interval === 7 || interval === 5) return 'compatible';
    } else if ((a.major && interval === 9) || (!a.major && interval === 3)) {
        // Relative minor / relative major: the same seven notes.
        return 'compatible';
    }
    // A semitone apart or a tritone apart: the two most dissonant things two mixes can do at once.
    if (interval === 1 || interval === 11 || interval === 6) return 'clashing';
    return 'neutral';
};

export interface StyleChoice {
    style: TransitionStyle;
    relation: KeyRelation;
    /** Multiplier the planner applies to its default length. */
    lengthScale: number;
    reason: string;
}

/**
 * Picks the kind of transition, most seamless first.
 *
 * Ordered rather than scored: each rule states a condition under which one particular join is
 * clearly right, and the last one is the fallback. A scoring function over the same inputs would
 * be harder to argue with when a transition sounds wrong.
 */
export const chooseTransitionStyle = (input: {
    from: TrackProfile | null;
    to: TrackProfile | null;
    /** The two tracks are neighbours on the same album, so a segue may have been written in. */
    sameAlbum: boolean;
}): StyleChoice => {
    const { from, to, sameAlbum } = input;
    const relation = keyRelation(from, to);
    const decide = (style: TransitionStyle, reason: string, extraScale = 1): StyleChoice => ({
        style,
        relation,
        lengthScale: LENGTH_SCALE[relation] * STYLE_SCALE[style] * extraScale,
        reason,
    });

    // Every test below reads the tail fields strictly against true/false, never for truthiness:
    // on a partial profile they are null, meaning "not knowable without downloading the file",
    // and treating that as "no" would silently pick the same transition a real "no" picks.

    // Both ends still sounding, on consecutive tracks of one album: the join is part of the record.
    // This is not the old "songs from one album do not get blended" rule wearing a hat - that one
    // refused to do anything, this one picks a better join, and the switch still acts every time.
    if (sameAlbum && from?.endsHot === true && to?.startsHot === true) {
        return decide('gapless', 'consecutive album tracks that run into each other');
    }

    // Nothing to fade into: the incoming track is at full level from its first bar.
    if (to?.startsHot === true && from?.bpm) {
        // A cut is only worth having if it lands somewhere musical, and landing it means waiting
        // for a beat of the outgoing track - a wait that can only be paid for out of the incoming
        // track's own leading silence, because the incoming deck starts when it starts. Without at
        // least a beat of silence to spend, the "cut" is an arbitrary chop a fraction of a second
        // from the end of the track, which is the feature appearing to do nothing at all.
        if (to.leadIn >= 60 / from.bpm) {
            return decide('beatCut', 'the next track starts at full level, so this one is cut');
        }
        return decide(
            'bassSwap',
            'the next track starts at full level, so the overlap is kept short',
            HOT_START_SCALE,
        );
    }

    // A produced fade-out. Fading a fade doubles it; overlap earlier and swap the low end instead.
    if (from?.outroSlope !== null && from?.outroSlope !== undefined
        && from.outroSlope <= FADE_OUT_SLOPE_DB_PER_SEC) {
        return decide('bassSwap', 'this track fades out on its own');
    }

    // A tail that decays rather than stops, and a next track with an intro to rise through it.
    if (from?.endsHot === false && to && (to.leadIn > INTRO_SILENCE_SEC || to.startsHot === false)) {
        return decide('tailRide', 'a decaying tail with an intro to come up underneath it');
    }

    if (from || to) return decide('bassSwap', 'overlapped, with the low end handed over');
    return decide('plainBlend', 'nothing measured about either track');
};

export interface BlendShapeRequest {
    style: TransitionStyle;
    /** Room in the outgoing track this transition has to work in, already clamped to what is left. */
    room: number;
    /** Handover length and position a fading style would use. */
    overlap: number;
    crossover: number;
    /** Seconds to the outgoing track's next beat, and its period. Null without a usable grid. */
    nextBeatIn: number | null;
    periodSec: number | null;
    /** Leading silence on the incoming track, which is what a wait can be spent on for free. */
    incomingLeadIn: number | null;
}

export interface StyledBlend {
    style: TransitionStyle;
    /** Seconds the incoming deck stays silent before the handover starts. */
    hold: number;
    /** Length of the handover itself. */
    overlap: number;
    crossover: number;
    bassSwap: boolean;
}

/**
 * Turns a chosen style into the schedule that realises it.
 *
 * All five come out as the same three numbers - wait this long, hand over for that long, cross at
 * this point - which is why there is one scheduling path in the session rather than five.
 *
 * The style can still change here. A gapless join needs to wait out whatever is left of the
 * outgoing track, and that is only free if the incoming track opens with at least that much
 * silence; when it does not, waiting would eat its first notes, so it becomes an overlap instead.
 */
export const shapeBlend = (request: BlendShapeRequest): StyledBlend => {
    const { style, room, overlap, crossover, nextBeatIn, periodSec, incomingLeadIn } = request;
    const headBudget = (incomingLeadIn ?? 0) + HEAD_BUDGET_SEC;

    if (style === 'gapless') {
        const hold = Math.max(0, room - GAPLESS_SPLICE_SEC);
        if (hold <= headBudget) {
            return { style, hold, overlap: GAPLESS_SPLICE_SEC, crossover: 0.5, bassSwap: false };
        }
        // The join cannot be placed without cutting into the next track. Overlap instead.
        return { style: 'bassSwap', hold: 0, overlap, crossover, bassSwap: true };
    }

    if (style === 'beatCut') {
        const maxHold = Math.min(room - BEAT_CUT_SEC, headBudget);
        // The latest beat of the outgoing track that fits inside what may be waited out. Usually
        // there is none - the incoming deck rarely starts with a beat to spare - and then the cut
        // simply happens now, which is still a cut and still not a fade.
        const steps = periodSec && nextBeatIn !== null && periodSec > 0
            ? Math.floor((maxHold - nextBeatIn) / periodSec)
            : -1;
        const hold = steps >= 0 ? nextBeatIn! + steps * periodSec! : 0;
        return { style, hold: Math.max(0, hold), overlap: BEAT_CUT_SEC, crossover: 0.5, bassSwap: false };
    }

    return { style, hold: 0, overlap, crossover, bassSwap: style !== 'plainBlend' };
};
