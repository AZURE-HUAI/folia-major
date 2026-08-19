import { CROSSFADE_DEFAULT_SEC, clampCrossfadeSeconds, planCrossfade } from './crossfadePlanner';
import { planTransition, type TransitionPlan, type TransitionTrack } from './transitionPlanner';

// src/services/automix/transitionStrategy.ts
// Which of the two strategies gets this song change. Nothing else lives here.
//
// The seam this sits on already existed: both planners answer with the same `TransitionPlan`, and
// `automixSession` has always executed a plan without caring who wrote it. So the two modes are
// genuinely two strategies rather than one strategy with a flag threaded through it - the shapes
// they can produce differ, not the switches they set. Adding a third would be another file here
// and no change to anything downstream.
//
// Pure, like both planners it dispatches to. The one impure question - can this build measure
// audio at all - is a separate export, and no planning path calls it.

export type TransitionMode =
    /** Fixed-length equal-power crossfade. The listener sets the maximum. */
    | 'crossfade'
    /** Measured evidence decides whether, when, how and how long. The listener sets nothing. */
    | 'automix';

export interface TransitionSettings {
    mode: TransitionMode;
    /** Seconds. The crossfade mode's ceiling; automix ignores it and computes its own. */
    crossfadeMaxSec: number;
}

export const DEFAULT_TRANSITION_SETTINGS: TransitionSettings = {
    // Automix, because it is what the existing switch has always done: a listener who already had
    // blending on must not find it behaving differently after an update.
    mode: 'automix',
    crossfadeMaxSec: CROSSFADE_DEFAULT_SEC,
};

export const isTransitionMode = (value: unknown): value is TransitionMode =>
    value === 'crossfade' || value === 'automix';

/**
 * Whether a track can be measured at all in this environment.
 *
 * Every automix decision is downstream of one offline analysis pass, and that pass needs an
 * OfflineAudioContext to decode into. Without one the mode cannot be more than a crossfade
 * wearing its name, so the setting says so instead of pretending. This is the only HARD block;
 * the common soft one - an online library with song caching switched off, so there are no bytes
 * anyone agreed to download - is a coverage question the settings page explains, not a capability.
 */
export const canAnalyseTracks = (): boolean => {
    if (typeof window === 'undefined') return false;
    const offline = window.OfflineAudioContext
        || (window as Window & { webkitOfflineAudioContext?: typeof OfflineAudioContext })
            .webkitOfflineAudioContext;
    return typeof offline === 'function';
};

/**
 * Whether automix has anything at all to be clever with.
 *
 * All THREE, because they are three separate inputs to three separate decisions and any one of
 * them puts automix somewhere a crossfade cannot go. Written as "is there an offline profile"
 * first, which was wrong and a test said so within the minute: a track with no profile still has
 * a tempo, measured live off the sounding deck, and that tempo is what makes a blend eight BARS
 * long instead of five seconds. Reading only the profile threw a 21.3s musical blend away and
 * replaced it with a 5s crossfade - the feature switched off by a guard meant to protect it.
 *
 * - a profile on either side: the style, the tone match, the placement, the length ceiling
 * - a tempo from anywhere: the length's unit, the entry alignment, whether a cut can be placed
 * - lyrics on the outgoing side: where the singing stops, which is where a handover may start
 */
const hasEvidence = (
    from: TransitionTrack,
    to: TransitionTrack,
    bpm: number | null,
): boolean => Boolean(
    from.profile
    || to.profile
    || (bpm !== null && Number.isFinite(bpm) && bpm > 0)
    || from.lines?.length,
);

/**
 * Picks the planner and runs it.
 *
 * The one branch worth reading twice is the last. Automix with no evidence is not automix being
 * cautious, it is automix with nothing to reason from: `chooseTransitionStyle` falls through every
 * measured rule to `plainBlend` and the length comes out of a constant. That IS a crossfade - so
 * it is handed to the crossfade planner, which places it against the same measured ends and says
 * in the log that it did. Same audible result, one behaviour to reason about instead of two, and
 * none of the moves that need evidence - a tempo bend, a beat cut, an echo throw - can be reached
 * out of an empty profile by accident.
 */
export const planForMode = (
    settings: TransitionSettings,
    from: TransitionTrack,
    to: TransitionTrack,
    bpm: number | null = null,
    at = 0,
): TransitionPlan => {
    if (settings.mode === 'crossfade') {
        return planCrossfade(from, to, clampCrossfadeSeconds(settings.crossfadeMaxSec), at);
    }
    if (hasEvidence(from, to, bpm)) return planTransition(from, to, bpm, at);

    const plan = planCrossfade(from, to, CROSSFADE_DEFAULT_SEC, at);
    // Deliberately not phrased like `chooseTransitionStyle`'s own "nothing measured about either
    // track" fallback, which is a sentence about picking a STYLE and reads identically in the log.
    // The two failures are different sizes and want telling apart at a glance.
    return { ...plan, reason: `automix has no evidence here, ${plan.reason} instead` };
};
