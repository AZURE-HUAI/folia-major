import type { Line } from '../../types';
import { isInterludeLine } from '../../utils/lyrics/parserCore';
import {
    chooseTransitionStyle,
    CUT_LEAD_SEC,
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
     * For the three overlapping styles this is the crossfade itself. For a cut it is the room the
     * transition is given to place itself in - most of which is spent waiting, and whatever is not
     * waited out is cut off.
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

/**
 * Longest run at the end of a track a transition may take as being "the ending".
 *
 * Master padding is a second or two and a produced fade-out runs to five or six, so ten covers
 * both with room. Past it the measurement is not describing an ending any more: a minute of
 * silence is the gap before a hidden track, and a two-minute decay is an ambient outro somebody
 * wrote on purpose. Anchoring a handover in front of either would delete a part of the song.
 */
const MAX_TRIMMED_TAIL_SEC = 10;

const beatSec = (bpm: number | null | undefined) =>
    (bpm && Number.isFinite(bpm) && bpm > 0 ? 60 / bpm : null);

/**
 * The two ends of the outgoing track that are not its file's end.
 *
 * A blend is scheduled backwards from "the end of the track", and that was read off the media
 * duration - so both of these were being treated as music. Measured over two listening sessions,
 * each one on its own accounts for a class of song change that arrives as silence:
 *
 * `sounding` - past it the file is digitally silent. Twenty-nine song changes, seven handed over
 * below -30 dBFS and four below -40, one of them 55 dB under the outgoing track's own level. Not
 * quiet transitions: the song had finished, and the listener heard a gap and then a fade-up.
 *
 * `body` - past it the track is decaying rather than playing. Fixing the first left five song
 * changes of which three still handed over at -23 to -26 dBFS, because the silence threshold is
 * forty dB under the track's PEAK, which on a modern master is thirty under its music. So a blend
 * aimed at `sounding` runs its whole length inside the decay. Aiming at `body` starts it while
 * the outgoing track is still carrying the song, and the decay then plays out underneath the
 * incoming one instead of in place of it - which is what `tailRide` was always for.
 *
 * Null on a head-only profile, which is the honest answer - the tail of an uncached track is not
 * downloadable - and then the file's own end is all there is to aim at, exactly as before.
 */
const endsOf = (track: TransitionTrack) => {
    const profile = track.profile && !track.profile.partial ? track.profile : null;
    const back = (seconds: number | null | undefined) => (
        seconds !== null && seconds !== undefined && seconds > 0
            ? track.duration - Math.min(seconds, MAX_TRIMMED_TAIL_SEC)
            : track.duration
    );
    return { sounding: back(profile?.leadOut), body: back(profile?.bodyOut) };
};

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
): TransitionPlan => {
    if (!Number.isFinite(from.duration) || from.duration <= 0) {
        return hardCut('outgoing duration unknown, nothing to schedule a fade against');
    }

    const choice = chooseTransitionStyle({
        from: from.profile ?? null,
        to: to.profile ?? null,
    });

    // Everything below is scheduled backwards from HERE, not from the end of the file.
    const { sounding: end, body } = endsOf(from);
    const trimmed = from.duration - end;
    const silence = trimmed > 0.05 ? `, skipped ${round(trimmed)}s of silence at the end` : '';

    // A cut does not want a length, it wants somewhere to stand: enough of the tail that the
    // incoming deck has finished loading inside it, and no more, because whatever is left over
    // when the handover lands is cut off.
    if (choice.style === 'beatCut') {
        // Never ask for more room than the cut can actually be placed in.
        //
        // Room is spent waiting, and the wait comes out of the incoming track's own leading
        // silence - shapeBlend will not spend a millisecond more than that. So asking for a second
        // and a half of it on a track that opens after a fifth of one produces a plan that is
        // guaranteed to be thrown away.
        //
        // CUT_LEAD_SEC is what a deck starting cold would need; these decks have been buffering
        // since the top of the transition window, so the only thing still to pay for is the moment
        // between letting go and hearing it - which RELEASE_MARGIN_SEC already covers.
        const placeable = to.profile ? to.profile.leadIn + HEAD_BUDGET_SEC : CUT_LEAD_SEC;
        // A quarter of the MUSIC, not of the file: a track padded with silence has less of itself
        // to spend than its duration claims, and this is also what keeps the anchor off zero.
        const room = Math.min(CUT_LEAD_SEC, end / 4, placeable);
        if (room < AUTOMIX_MIN_CUT_ROOM_SEC) {
            return hardCut(`track too short to place a cut in (${round(end)}s)`);
        }
        // No `body` here, and that is what a cut IS: the styles that reach this branch were chosen
        // because the outgoing track is still at full level when it stops, so its body runs to the
        // last sounding frame and the two answers are the same one.
        return {
            kind: 'fade',
            style: choice.style,
            relation: choice.relation,
            outStart: round(end - room),
            inStart: 0,
            overlap: round(room),
            minOverlap: AUTOMIX_MIN_CUT_ROOM_SEC,
            reason: `${choice.style} - ${choice.reason}${silence}`,
        };
    }

    const beat = beatSec(bpm);
    const lastSung = lastSungMoment(from.lines);
    // Against the last sounding moment for the same reason: a lyric timeline that stops eight
    // seconds before a file that carries five seconds of silence has a three-second instrumental
    // outro, not an eight-second one, and only one of those two numbers is somewhere to put a blend.
    const tail = lastSung === null ? null : Math.max(0, end - lastSung);  // instrumental outro
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
    // Back to whole beats after scaling, or the point of counting in beats is lost on the way out:
    // eight beats shortened by 0.6 is 4.8 of them, which is not a length any music has.
    const wanted = toWholeBeats(
        (beat === null ? AUTOMIX_DEFAULT_OVERLAP_SEC : beat * AUTOMIX_DEFAULT_OVERLAP_BEATS)
        * choice.lengthScale,
        beat,
    );
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
    const overlap = Math.min(bounded, AUTOMIX_MAX_OVERLAP_SEC, end / 4);

    // Only a track of a few seconds can land here, and there is no fade to be had in it.
    if (overlap < AUTOMIX_MIN_OVERLAP_SEC) {
        return hardCut(`track too short to fade across (${round(end)}s)`);
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
    // Three clauses, and the order between them is the whole decision.
    //
    // Latest: where the blend sits when the track just stops - flush against the last sounding
    // moment. Body: the top of the decay, taken instead when the decay starts earlier than that,
    // so the handover happens while the outgoing track is still carrying the song rather than
    // fifteen dB into its own fade-out. Floor: never before the singing stopped, because two vocal
    // lines stacked on each other is the one thing that makes an overlap sound wrong, and moving
    // the anchor earlier is exactly the way to cause it.
    const latest = end - overlap;
    const outStart = Math.min(latest, Math.max(body, lastSung ?? 0));
    const rode = latest - outStart;
    const fadeOut = rode > 0.05 ? `, started ${round(rode)}s early to ride the fade-out` : '';

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
        outStart: round(outStart),
        inStart: 0,
        overlap: round(overlap),
        minOverlap: AUTOMIX_MIN_OVERLAP_SEC,
        reason: `${choice.style} ${round(overlap)}s ${length}`
            + ` (${window}${key}${outgoingTail}${silence}${fadeOut})`,
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
