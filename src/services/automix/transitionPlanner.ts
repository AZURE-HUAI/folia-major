import type { Line } from '../../types';
import { isInterludeLine } from '../../utils/lyrics/parserCore';

// src/services/automix/transitionPlanner.ts
// Decides HOW LONG two songs should overlap. Pure - no audio, no DOM, no clock.
// The switch means "blend my song changes", so every song change gets a blend. The lyric
// timeline only chooses the length: where it can prove a vocal-free window, the blend lands in
// it; where it cannot, the blend still happens at the default length. The only 'hardCut' left is
// for a track whose end is genuinely unknowable, which is a missing fact and not a judgement.

export interface TransitionTrack {
    /** Seconds. Non-finite (live/unknown streams) leaves nothing to schedule against. */
    duration: number;
    /** Timed lyric lines when available; null for instrumentals or missing lyric files. */
    lines: Line[] | null;
}

export type TransitionKind = 'hardCut' | 'fade';

export interface TransitionPlan {
    kind: TransitionKind;
    /** Seconds into the outgoing track where the incoming one starts and the fade begins. */
    outStart: number;
    /** Seconds into the incoming track to start playback from. */
    inStart: number;
    /** Overlap length in seconds. 0 for hardCut. */
    overlap: number;
    /** How the length was chosen. Surfaced in the console, not cosmetic. */
    reason: string;
}

/** Longest blend we ever ask for. Beyond this a transition stops reading as one song ending. */
export const AUTOMIX_MAX_OVERLAP_SEC = 8;
/** Floor for a blend to be one. Below this there is no time left to fade across, only a cut. */
export const AUTOMIX_MIN_OVERLAP_SEC = 0.8;
/** Used whenever the lyrics cannot point at a better window. The main tuning knob for feel. */
export const AUTOMIX_DEFAULT_OVERLAP_SEC = 5;

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
    return { start: sung[0].startTime, end: sung[sung.length - 1].endTime };
};

const hardCut = (reason: string): TransitionPlan => ({
    kind: 'hardCut', outStart: 0, inStart: 0, overlap: 0, reason,
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
export const planTransition = (from: TransitionTrack, to: TransitionTrack): TransitionPlan => {
    if (!Number.isFinite(from.duration) || from.duration <= 0) {
        return hardCut('outgoing duration unknown, nothing to schedule a fade against');
    }

    const outVocals = vocalBounds(from.lines);
    const inVocals = vocalBounds(to.lines);
    const tail = outVocals ? from.duration - outVocals.end : null;   // instrumental outro
    const intro = inVocals ? inVocals.start : null;                   // instrumental intro
    const vocalFree = tail !== null && intro !== null ? Math.min(tail, intro) : null;
    const usesVocalFree = vocalFree !== null && vocalFree >= AUTOMIX_MIN_OVERLAP_SEC;

    // Quarter-length cap so a very short track is not half crossfade.
    const overlap = Math.min(
        usesVocalFree ? vocalFree : AUTOMIX_DEFAULT_OVERLAP_SEC,
        AUTOMIX_MAX_OVERLAP_SEC,
        from.duration / 4,
    );

    // Only a track of a few seconds can land here, and there is no fade to be had in it.
    if (overlap < AUTOMIX_MIN_OVERLAP_SEC) {
        return hardCut(`track too short to fade across (${round(from.duration)}s)`);
    }

    const window = tail === null || intro === null
        ? `no lyric timeline on ${tail === null ? 'outgoing' : 'incoming'}`
        : `outro ${round(tail)}s, intro ${round(intro)}s`;

    return {
        kind: 'fade',
        outStart: round(from.duration - overlap),
        inStart: 0,
        overlap: round(overlap),
        reason: `${round(overlap)}s ${usesVocalFree ? 'vocal-free' : 'default'} (${window})`,
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
    return overlap >= AUTOMIX_MIN_OVERLAP_SEC ? round(overlap) : 0;
};

/**
 * Equal-power crossfade gains for progress 0..1.
 *
 * Equal-power rather than linear because the two tracks are uncorrelated: summing two linear
 * ramps dips ~3dB at the midpoint and the blend audibly sags.
 */
export const equalPowerGains = (progress: number): { out: number; in: number } => {
    const p = Math.min(1, Math.max(0, progress));
    return { out: Math.cos(p * Math.PI / 2), in: Math.sin(p * Math.PI / 2) };
};
