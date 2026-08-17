// src/services/automix/tempoBend.ts
// Running a deck at a different tempo without moving its pitch.
//
// This used to be an AudioWorklet, on the premise that `playbackRate` is a resampler and therefore
// moves pitch and tempo together, leaving pitch correction as the missing half. That premise is
// true of a resampler and false of a media element: `preservesPitch` defaults to TRUE, so the
// element already carries a time stretcher - the same one that makes video sites' speed control
// usable - and it runs in the browser's audio renderer, upstream of where Web Audio taps the
// element. So the correction was applied twice: once by the element and once by us, leaving the
// outgoing track a fourth sharp on a 0.75x bend. That is what "it goes out of tune" was.
//
// The whole file is now the one property the platform already exposes, made explicit rather than
// left to a default, plus the rate itself. What was deleted: a WSOLA worklet, its own module chunk,
// its splice search on the audio thread, and twenty milliseconds of latency on every deck for ever.

/**
 * Sets a deck's tempo, pitch intact.
 *
 * `preservesPitch` is written every time rather than once at setup: it is a property of the element
 * and elements are recycled, and a rate applied while it is false is an audible detune rather than
 * a tempo match. Its default is already true; this makes the dependency a statement instead of an
 * assumption, which is the only reason it appears at all.
 */
export const applyTempoBend = (
    element: HTMLAudioElement,
    rate: number,
): number => {
    if (!(rate > 0) || Math.abs(rate - 1) < 0.001) {
        resetTempoBend(element);
        return 1;
    }
    element.preservesPitch = true;
    element.playbackRate = rate;
    return rate;
};

/** Puts a deck back at its own tempo. Part of every settle, like the gains and the tone are. */
export const resetTempoBend = (element: HTMLAudioElement | null) => {
    if (element && element.playbackRate !== 1) element.playbackRate = 1;
};
