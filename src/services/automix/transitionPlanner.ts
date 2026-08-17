import type { Line } from '../../types';
import { isInterludeLine } from '../../utils/lyrics/parserCore';
import {
    chooseTransitionStyle,
    CUT_LEAD_SEC,
    GAPLESS_LEAD_SEC,
    GAPLESS_SPLICE_SEC,
    HEAD_BUDGET_SEC,
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
const AUTOMIX_MIN_CUT_ROOM_SEC = 0.15;
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
const AUTOMIX_DEFAULT_OVERLAP_BEATS = 8;

const beatSec = (bpm: number | null | undefined) =>
    (bpm && Number.isFinite(bpm) && bpm > 0 ? 60 / bpm : null);

/** Rounds a length down to whole beats, so a blend never ends mid-pulse. */
const toWholeBeats = (seconds: number, beat: number | null) =>
    (beat === null ? seconds : Math.max(1, Math.floor(seconds / beat)) * beat);

/**
 * Last moment a voice is present, from the lyric timeline.
 *
 * The END of a track only. Where the singing STARTS is measured from the audio instead - see
 * `vocalStart` in trackProfile - because a lyric file's opening is not the song's opening: every
 * online source prepends a credit block, and the three of them format it three incompatible ways.
 * The end of the file carries no such block, so the timeline is trustworthy there.
 *
 * Interlude placeholders are dropped, and that is load-bearing rather than tidy: attachInterludes
 * prepends a '......' line at 0.5s to every track whose singing starts after 0:03. Blank lines go
 * for the same reason - some sources use those as the placeholder instead.
 */
const lastSungMoment = (lines: Line[] | null | undefined): number | null => {
    const sung = lines?.filter(line => line.fullText.trim().length > 0 && !isInterludeLine(line));
    return sung?.length ? sung[sung.length - 1].endTime : null;
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
        // Never ask for more room than the join can actually be placed in.
        //
        // Room is spent waiting, and the wait comes out of the incoming track's own leading
        // silence - shapeBlend will not spend a millisecond more than that, and abandons the style
        // outright when the room it was handed needs more. So asking for a second and a half of it
        // on a track that opens after a fifth of one produces a plan that is guaranteed to be
        // thrown away, which is exactly how a gapless join came to be chosen on real song changes
        // and then never once performed.
        //
        // The lead is what a deck starting cold would need; these decks have been buffering since
        // the top of the transition window, so the only thing still to pay for is the moment
        // between letting go and hearing it - which RELEASE_MARGIN_SEC already covers.
        const placeable = to.profile ? to.profile.leadIn + HEAD_BUDGET_SEC : lead;
        const room = Math.min(lead, from.duration / 4, placeable);
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
    const lastSung = lastSungMoment(from.lines);
    const tail = lastSung === null ? null : from.duration - lastSung;  // instrumental outro
    // Measured off the audio, not read off the incoming lyric file. The two ends of a transition
    // are asymmetric: a lyric timeline's END is trustworthy, its BEGINNING is a credit block.
    //
    // The structural boundary, and ONLY it. `vocalStart` is measured and reported alongside, but
    // it does not get a vote, and that is a measurement rather than a preference: across six real
    // tracks it was exact on one (Runaway, 17.46s against a first sung line at 17.5s), plausible
    // on one, and near zero on three - including an instrumental with no voice in it at all. Its
    // errors all land on "the voice starts immediately", which is the one answer that destroys the
    // window. `sectionStart` came in EARLIER than the true vocal entry on every track it could be
    // checked against, and early is the harmless direction: the blend is over before anyone sings.
    const intro = to.profile?.sectionStart ?? null;
    const vocalFree = tail !== null && intro !== null ? Math.min(tail, intro) : null;
    const usesVocalFree = vocalFree !== null && vocalFree >= AUTOMIX_MIN_OVERLAP_SEC;

    // Eight beats of the outgoing track, then scaled: longer when the two keys sit together or the
    // tail wants riding, shorter when they clash. A clash is not removed, it is denied the time to
    // be noticed.
    const wanted = (beat === null ? AUTOMIX_DEFAULT_OVERLAP_SEC : beat * AUTOMIX_DEFAULT_OVERLAP_BEATS)
        * choice.lengthScale;
    // The proven window is a CEILING on that length, never the length itself.
    //
    // It answers "where may a handover go", not "how long should one be", and spending all of it
    // conflates the two: a track with a 26s outro into an 11s intro would take the whole ceiling,
    // so every generously-spaced pair came out as an eight-second crossfade - twenty-three beats
    // at 185 BPM - which is precisely the "it just fades" this file exists to answer. Tempo sets
    // the length; the window can only shorten it, trimmed back to whole beats so a blend forced
    // into a narrow gap still ends on a pulse.
    const bounded = usesVocalFree ? Math.min(wanted, toWholeBeats(vocalFree, beat)) : wanted;

    // Quarter-length cap so a very short track is not half crossfade.
    const overlap = Math.min(bounded, AUTOMIX_MAX_OVERLAP_SEC, from.duration / 4);

    // Only a track of a few seconds can land here, and there is no fade to be had in it.
    if (overlap < AUTOMIX_MIN_OVERLAP_SEC) {
        return hardCut(`track too short to fade across (${round(from.duration)}s)`);
    }

    // Each end fails for its own reason and they want telling apart: the outgoing side can only
    // fail on its lyric file, the incoming side only on its analysis.
    const outroMissing = from.lines?.length
        ? 'nothing sung in the outgoing lyrics'
        : 'no lyrics for the outgoing track';
    const introMissing = to.profile
        ? 'nothing measurable at the start of the incoming track'
        : 'the incoming track was never analysed';
    const window = tail === null
        ? outroMissing
        : intro === null
            ? introMissing
            : `outro ${round(tail)}s, intro ${round(intro)}s`;
    const length = `${beat === null ? 'default' : `${round(overlap / beat)} beats`}`
        + (bounded < wanted ? ', capped by the vocal-free window' : '');
    const key = choice.relation === 'unknown' ? '' : `, ${choice.relation} keys`;
    // Four of the five joins are decided on how the OUTGOING track ends, and a head-only profile
    // knows nothing about that - so they cannot be reached at all and every song change comes out
    // as an overlap. Worth saying out loud: without it the log reads as "these two songs wanted an
    // overlap" when what happened is that nothing else was ever on the table.
    const outgoingTail = !from.profile
        ? ', outgoing never analysed'
        : from.profile.partial ? ', outgoing tail not analysed' : '';

    return {
        kind: 'fade',
        style: choice.style,
        relation: choice.relation,
        outStart: round(from.duration - overlap),
        inStart: 0,
        overlap: round(overlap),
        minOverlap: AUTOMIX_MIN_OVERLAP_SEC,
        reason: `${choice.style} ${round(overlap)}s ${length} (${window}${key}${outgoingTail})`,
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
