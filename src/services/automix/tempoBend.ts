import { tempoBendLatencySec } from './tempoBendProcessor.js';

// src/services/automix/tempoBend.ts
// The main-thread half of running a deck at a different tempo without moving its pitch.
//
// A media element has exactly one tempo control, `playbackRate`, and it is a resampler: it moves
// pitch by the same factor. So the tempo half of a transition is two things that have to happen
// together - a rate on the element, and a pitch shift of one over that rate on the deck's signal -
// and this file owns the pairing. Everything that can fail here fails quietly and downwards: no
// worklet means no pitch correction, which means the rate is only used where it is small enough
// not to need any.

/** The name the processor registers itself under. */
const PROCESSOR = 'automix-tempo-bend';

/**
 * How far a raw rate change may go before the pitch shift has to be corrected.
 *
 * A semitone is 5.946%. Under it the shift is smaller than the smallest interval the music itself
 * uses, on a track that is on its way out, and nobody identifies it as wrong. Over it the correction
 * is worth its own artefacts.
 */
export const RAW_BEND_LIMIT = 0.0594;

let loading: Promise<boolean> | null = null;

/**
 * Registers the processor once per context.
 *
 * Started early and never awaited by anything that has to be fast. The module is a local file, so
 * this resolves in a few milliseconds, but a transition that arrives before it does simply runs
 * without it rather than waiting.
 */
export const ensureTempoBendModule = (context: AudioContext): Promise<boolean> => {
    if (loading) return loading;
    loading = (async () => {
        if (!context.audioWorklet) return false;
        try {
            await context.audioWorklet.addModule(
                new URL('./tempoBendProcessor.js', import.meta.url),
            );
            return true;
        } catch (error) {
            console.warn('[Automix] tempo matching is off: the worklet would not load', error);
            return false;
        }
    })();
    return loading;
};

export interface TempoBendHandle {
    node: AudioWorkletNode;
    /** How far this node's output runs behind its input. Constant, and the same on both decks. */
    latencySec: number;
}

/**
 * Puts a bend node into a chain, between two nodes that are already connected.
 *
 * Only ever called while the deck in question is silent - armed and not yet playing, or paused after
 * a transition. The node adds a fixed twenty milliseconds of latency, and splicing it in under a
 * sounding track would repeat that much audio. Under a silent one it costs nothing, and both decks
 * end up carrying the same latency, which is the property that actually matters: a delay on one deck
 * only would pull the two apart by exactly the amount a transition is trying to align them to.
 */
export const insertTempoBend = (
    context: AudioContext,
    from: AudioNode,
    to: AudioNode,
): TempoBendHandle | null => {
    try {
        const node = new AudioWorkletNode(context, PROCESSOR, {
            numberOfInputs: 1,
            numberOfOutputs: 1,
            outputChannelCount: [2],
            channelCount: 2,
            channelCountMode: 'explicit',
        });
        from.disconnect(to);
        from.connect(node).connect(to);
        return { node, latencySec: tempoBendLatencySec(context.sampleRate) };
    } catch (error) {
        // Most often "the processor is not registered yet", which is a timing answer rather than a
        // failure: the next transition will find it there.
        console.warn('[Automix] could not add the tempo bend to a deck', error);
        return null;
    }
};

/**
 * Sets a deck's tempo, and corrects the pitch that comes with it.
 *
 * Two writes that have to agree, which is the whole reason they are in one function. `rate` is what
 * the element is asked to run at; the correction is one over it, because the element has already
 * moved the pitch by exactly that factor and this puts it back.
 *
 * Returns what was actually done, which is not always what was asked: without a bend node a rate
 * past a semitone is refused outright rather than applied as an audible detune.
 */
export const applyTempoBend = (
    element: HTMLAudioElement,
    handle: TempoBendHandle | null,
    rate: number,
    /** Audio-clock time the change lands on, so it can be put where the music hides it. */
    at: number,
): number => {
    const deviation = Math.abs(rate - 1);
    if (!(rate > 0) || deviation < 0.001) {
        reset(element, handle, at);
        return 1;
    }
    if (!handle && deviation > RAW_BEND_LIMIT) return 1;

    element.playbackRate = rate;
    if (handle) {
        const pitch = handle.node.parameters.get('pitch');
        pitch?.cancelScheduledValues(at);
        pitch?.setValueAtTime(1 / rate, at);
    }
    return rate;
};

const reset = (element: HTMLAudioElement, handle: TempoBendHandle | null, at: number) => {
    if (element.playbackRate !== 1) element.playbackRate = 1;
    const pitch = handle?.node.parameters.get('pitch');
    pitch?.cancelScheduledValues(at);
    pitch?.setValueAtTime(1, at);
};

/** Puts a deck back at its own tempo. Part of every settle, like the gains and the tone are. */
export const resetTempoBend = (
    element: HTMLAudioElement | null,
    handle: TempoBendHandle | null,
    at: number,
) => {
    if (element) reset(element, handle, at);
    else if (handle) {
        const pitch = handle.node.parameters.get('pitch');
        pitch?.cancelScheduledValues(at);
        pitch?.setValueAtTime(1, at);
    }
};
