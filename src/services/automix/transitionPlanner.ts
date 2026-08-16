import type { Line } from '../../types';
import { isInterludeLine } from '../../utils/lyrics/parserCore';
import {
    chooseTransitionStyle,
    CUT_LEAD_SEC,
    GAPLESS_LEAD_SEC,
    GAPLESS_SPLICE_SEC,
    type KeyRelation,
    type TransitionStyle,
} from './transitionChooser';
import type { TrackProfile } from './trackProfile';

// src/services/automix/transitionPlanner.ts
// Decides WHICH transition two songs get and HOW MUCH of the outgoing track it occupies. Pure -
// no audio, no DOM, no clock.
// The switch means "blend my song changes", so every song change gets one. The lyric timeline and
// the offline profiles only choose the kind and the length: where a vocal-free window can be
// proven, the handover lands in it; where it cannot, it still happens at the default length. The
// only 'hardCut' left is for a track whose end is genuinely unknowable, which is a missing fact
// and not a judgement.

export interface TransitionTrack {
    /** Seconds. Non-finite (live/unknown streams) leaves nothing to schedule against. */
    duration: number;
    /** Timed lyric lines when available; null for instrumentals or missing lyric files. */
    lines: Line[] | null;
    /** Offline measurement of the file, when it has been analysed. */
    profile?: TrackProfile | null;
}

export type TransitionKind = 'hardCut' | 'fade';

export interface TransitionPlan {
    kind: TransitionKind;
    /** Which of the five joins this is. Decided here, realised by shapeBlend. */
    style: TransitionStyle;
    /** How the two keys sit together. Reported so a length can be argued with. */
    relation: KeyRelation;
    /** Seconds into the outgoing track where the incoming one starts and the fade begins. */
    outStart: number;
    /** Seconds into the incoming track to start playback from. */
    inStart: number;
    /**
     * How much of the outgoing track's tail this transition occupies, in seconds.
     *
     * For the three overlapping styles this is the crossfade itself. For a cut or a gapless join
     * it is the room the transition is given to place itself in - most of which is spent waiting,
     * and whatever is not waited out is cut off.
     */
    overlap: number;
    /** Shortest room this style can still work in, checked again when the incoming deck starts. */
    minOverlap: number;
    /** How the length was chosen. Surfaced in the console, not cosmetic. */
    reason: string;
}

/** Longest blend we ever ask for. Beyond this a transition stops reading as one song ending. */
export const AUTOMIX_MAX_OVERLAP_SEC = 8;
/** Floor for a blend to be one. Below this there is no time left to fade across, only a cut. */
export const AUTOMIX_MIN_OVERLAP_SEC = 0.8;
/**
 * The same floor for a cut, which needs far less.
 *
 * A cut only has to fit its own 40ms and leave a little either side; holding it to the crossfade's
 * floor would throw away every cut whose incoming deck happened to load slowly, and replace it
 * with the abrupt stop that floor exists to prevent.
 */
export const AUTOMIX_MIN_CUT_ROOM_SEC = 0.15;
/** Used whenever neither the lyrics nor a tempo can point at a better length. */
export const AUTOMIX_DEFAULT_OVERLAP_SEC = 5;
/**
 * The length a blend really wants, in beats rather than seconds.
 *
 * A fixed number of seconds is the wrong unit: five seconds is two bars of a ballad and nearly
 * four of a fast track, so the same setting reads as leisurely on one song and frantic on the
 * next. Every DJ tool counts transitions in bars for this reason; eight beats is two bars of 4/4,
 * the shortest span that still reads as a phrase.
 */
export const AUTOMIX_DEFAULT_OVERLAP_BEATS = 8;

/** Stamped this early is stamped at the top of the file, not sung at the top of the song. */
const CREDIT_STAMP_SEC = 0.05;
/**
 * How long the silence after the credit block has to be before it counts as an intro.
 *
 * The same three seconds `attachInterludes` uses to decide a track starts singing late, and for
 * the same reason: below it there is no window to place anything in, so whether those opening
 * lines were credits or lyrics stops mattering.
 */
const CREDIT_MIN_GAP_SEC = 3;

const beatSec = (bpm: number | null | undefined) =>
    (bpm && Number.isFinite(bpm) && bpm > 0 ? 60 / bpm : null);

/** Rounds a length down to whole beats, so a blend never ends mid-pulse. */
const toWholeBeats = (seconds: number, beat: number | null) =>
    (beat === null ? seconds : Math.max(1, Math.floor(seconds / beat)) * beat);

/**
 * First and last moment a voice is present, from the lyric timeline.
 *
 * Interlude placeholders are dropped, and that is load-bearing rather than tidy: attachInterludes
 * prepends a '......' line at 0.5s to every track whose singing starts after 0:03, so counting it
 * as a voice reports an intro of half a second for almost every song in existence and vetoes the
 * blend. Blank lines go for the same reason - some sources use those as the placeholder instead.
 */
const vocalBounds = (lines: Line[] | null | undefined): { start: number; end: number } | null => {
    const sung = lines?.filter(line => line.fullText.trim().length > 0 && !isInterludeLine(line));
    if (!sung?.length) return null;

    // Skip the credit block online lyric files open with. Recognised by its shape rather than by
    // its wording - a list of role names would be one language's list, and wrong for the next
    // file: these lines sit at timestamp zero, several of them often share that exact timestamp
    // (no performance sings three lines at once), and a real intro follows. Reading them as the
    // first sung moment reported an intro of zero seconds for very nearly every online track,
    // which threw away the vocal-free window on all of them.
    let first = 0;
    while (first < sung.length - 1 && sung[first].startTime <= CREDIT_STAMP_SEC) first += 1;
    // Unless singing really does resume straight away, in which case those were lyrics after all.
    if (sung[first].startTime < CREDIT_MIN_GAP_SEC) first = 0;

    return { start: sung[first].startTime, end: sung[sung.length - 1].endTime };
};

const hardCut = (reason: string): TransitionPlan => ({
    kind: 'hardCut',
    style: 'plainBlend',
    relation: 'unknown',
    outStart: 0,
    inStart: 0,
    overlap: 0,
    minOverlap: AUTOMIX_MIN_OVERLAP_SEC,
    reason,
});

const round = (seconds: number) => Math.round(seconds * 100) / 100;

/**
 * Picks how long a song change should overlap.
 *
 * Preferred window: where NEITHER track is singing - the outgoing instrumental outro against the
 * incoming instrumental intro. Two vocal lines stacked on each other is the one thing that makes
 * a crossfade sound wrong, and the lyric timeline states exactly where they are, so when it can
 * prove such a window the blend is placed inside it.
 *
 * When it cannot - no lyrics, or a track that sings to the last second - the blend still happens
 * at AUTOMIX_DEFAULT_OVERLAP_SEC. The listener switched this on; declining to blend and calling
 * it good taste would just be the feature not working.
 */
export const planTransition = (
    from: TransitionTrack,
    to: TransitionTrack,
    /** Measured tempo of the outgoing track, when there is one. Sets the unit for the length. */
    bpm: number | null = null,
    options: { sameAlbum?: boolean } = {},
): TransitionPlan => {
    if (!Number.isFinite(from.duration) || from.duration <= 0) {
        return hardCut('outgoing duration unknown, nothing to schedule a fade against');
    }

    const choice = chooseTransitionStyle({
        from: from.profile ?? null,
        to: to.profile ?? null,
        sameAlbum: Boolean(options.sameAlbum),
    });

    // A join and a cut do not want a length, they want somewhere to stand: enough of the tail that
    // the incoming deck has finished loading inside it, and no more, because whatever is left over
    // when the handover lands is cut off.
    if (choice.style === 'gapless' || choice.style === 'beatCut') {
        const lead = choice.style === 'gapless' ? GAPLESS_LEAD_SEC : CUT_LEAD_SEC;
        const room = Math.min(lead, from.duration / 4);
        const floor = choice.style === 'gapless' ? GAPLESS_SPLICE_SEC * 4 : AUTOMIX_MIN_CUT_ROOM_SEC;
        if (room < floor) return hardCut(`track too short to place a join in (${round(from.duration)}s)`);
        return {
            kind: 'fade',
            style: choice.style,
            relation: choice.relation,
            outStart: round(from.duration - room),
            inStart: 0,
            overlap: round(room),
            minOverlap: floor,
            reason: `${choice.style} - ${choice.reason}`,
        };
    }

    const beat = beatSec(bpm);
    const outVocals = vocalBounds(from.lines);
    const inVocals = vocalBounds(to.lines);
    const tail = outVocals ? from.duration - outVocals.end : null;   // instrumental outro
    const intro = inVocals ? inVocals.start : null;                   // instrumental intro
    const vocalFree = tail !== null && intro !== null ? Math.min(tail, intro) : null;
    const usesVocalFree = vocalFree !== null && vocalFree >= AUTOMIX_MIN_OVERLAP_SEC;

    const wanted = usesVocalFree
        // The gap the lyrics prove is the better evidence, trimmed back to whole beats.
        ? toWholeBeats(vocalFree, beat)
        // Everything else is eight beats of the outgoing track, then scaled: longer when the two
        // keys sit together or the tail wants riding, shorter when they clash. A clash is not
        // removed, it is denied the time to be noticed.
        : (beat === null ? AUTOMIX_DEFAULT_OVERLAP_SEC : beat * AUTOMIX_DEFAULT_OVERLAP_BEATS)
        * choice.lengthScale;

    // Quarter-length cap so a very short track is not half crossfade.
    const overlap = Math.min(wanted, AUTOMIX_MAX_OVERLAP_SEC, from.duration / 4);

    // Only a track of a few seconds can land here, and there is no fade to be had in it.
    if (overlap < AUTOMIX_MIN_OVERLAP_SEC) {
        return hardCut(`track too short to fade across (${round(from.duration)}s)`);
    }

    // Worth separating: a track with no lyric file and a track whose lyric file holds nothing
    // sung - an instrumental interlude, say - look identical in a blend but mean different things
    // when the question is why a window could not be proven.
    const missing = (lines: Line[] | null, side: string) =>
        (lines?.length ? `nothing sung in the ${side} lyrics` : `no lyrics for the ${side} track`);
    const window = tail === null
        ? missing(from.lines, 'outgoing')
        : intro === null
            ? missing(to.lines, 'incoming')
            : `outro ${round(tail)}s, intro ${round(intro)}s`;
    const length = usesVocalFree
        ? 'vocal-free'
        : beat === null ? 'default' : `${round(overlap / beat)} beats`;
    const key = choice.relation === 'unknown' ? '' : `, ${choice.relation} keys`;

    return {
        kind: 'fade',
        style: choice.style,
        relation: choice.relation,
        outStart: round(from.duration - overlap),
        inStart: 0,
        overlap: round(overlap),
        minOverlap: AUTOMIX_MIN_OVERLAP_SEC,
        reason: `${choice.style} ${round(overlap)}s ${length} (${window}${key})`,
    };
};

/**
 * Second and final gate, run at the instant the incoming deck actually starts.
 *
 * The plan is made a few seconds before the incoming track has loaded, so by the time it plays
 * the outgoing track may have less left than planned (slow URL resolve, cold buffer). Fading over
 * a window that no longer exists would leave the blend truncated mid-curve, which sounds like a
 * dropout - clamp to what is really there and take the clean cut if that is no longer a blend.
 */
export const resolveOverlap = (plan: TransitionPlan, remainingSec: number): number => {
    if (plan.kind !== 'fade' || !Number.isFinite(remainingSec)) return 0;
    const overlap = Math.min(plan.overlap, remainingSec);
    return overlap >= plan.minOverlap ? round(overlap) : 0;
};
