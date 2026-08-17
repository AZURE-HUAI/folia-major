// src/services/automix/tempoBendProcessor.js
// Pitch correction for a deck whose playbackRate has been moved, so the two tracks in a transition
// can be put on one tempo without one of them sounding like a tape slowing down.
//
// Why this is the shape of the fix. A media element's playbackRate changes tempo and pitch
// together, because it is a resampler and that is what resamplers do: a quarter faster is also
// three and a bit semitones sharp. Undoing the pitch and keeping the tempo is therefore not a
// second, separate feature - it is the other half of the only tempo control a media element has.
// Composed the other way round (stretch time, then resample) the two operations are the standard
// pitch shifter; composed this way the element does the resampling for free and this only has to
// do the stretch.
//
// Deliberately a plain, self-contained ES module with no imports: it is loaded into
// AudioWorkletGlobalScope by URL, where the app's bundle does not exist, and it is imported
// directly by the unit tests, where AudioWorkletProcessor does not exist. The class below is the
// whole algorithm and knows about neither.

/** Ring buffer length. Comfortably more than the read pointer can ever lag behind the write. */
const RING = 1 << 15;
/** How long a splice is crossfaded over. Long enough to be inaudible, short enough to stay local. */
const XFADE = 192;
/** How far either side of the nominal jump a better-correlating splice point is looked for. */
const SEARCH = 220;
/** Output samples between splices. One splice per ~21ms of output at 48k. */
const SEQ = 1024;
/**
 * How far the read pointer is kept behind the write pointer.
 *
 * This is the processor's latency, and it is paid on every sample of playback rather than only
 * during a transition - the alternative is a bypass path with no delay, and switching between the
 * two mid-track is a jump of exactly this size. A constant twenty milliseconds is inaudible and,
 * more to the point, identical on both decks, so it cannot pull them apart. A latency that appeared
 * and disappeared would do precisely that.
 */
const LAG = 1000;
/** Samples of drift tolerated before a splice is worth its own artefact. */
const DEAD_ZONE = 32;

/**
 * Waveform-similarity overlap-add, over as many channels as are handed to it.
 *
 * One splice decision for all channels, taken on the first one. Correlating each channel separately
 * would let the left and right jump to different places, which does not sound like a slightly worse
 * stretch - it sounds like the stereo image tearing.
 */
export class TempoBend {
    constructor(channels = 2) {
        this.rings = Array.from({ length: channels }, () => new Float32Array(RING));
        /** Total samples written. The read position is absolute in the same space. */
        this.written = 0;
        this.read = 0;
        this.pitch = 1;
        /** Output samples until the next splice is considered. */
        this.untilSplice = SEQ;
        /** While crossfading: the position being faded out, and how much of the fade is left. */
        this.fading = 0;
        this.readOut = 0;
        this.primed = false;
    }

    /** Linear interpolation of one channel at an absolute position. */
    at(channel, position) {
        const ring = this.rings[channel];
        const base = Math.floor(position);
        const frac = position - base;
        const a = ring[((base % RING) + RING) % RING];
        const b = ring[(((base + 1) % RING) + RING) % RING];
        return a + (b - a) * frac;
    }

    /**
     * The jump that best continues the waveform.
     *
     * A stretch works by repeating or skipping a stretch of audio. Doing that at an arbitrary point
     * puts a discontinuity in every periodic component at once, which is heard as a click or, over
     * many splices, as a warble. Choosing the offset whose neighbourhood best matches what was about
     * to be played instead lands the splice where the waveform is already repeating itself - which
     * for music is once per pitch period, and is why this costs a correlation rather than a guess.
     */
    bestOffset(nominal) {
        let best = 0;
        let bestScore = -Infinity;
        for (let delta = -SEARCH; delta <= SEARCH; delta += 2) {
            let dot = 0;
            let energy = 0;
            for (let k = 0; k < XFADE; k += 2) {
                const a = this.at(0, this.read + k);
                const b = this.at(0, this.read + nominal + delta + k);
                dot += a * b;
                energy += b * b;
            }
            const score = dot / Math.sqrt(energy + 1e-9);
            if (score > bestScore) {
                bestScore = score;
                best = delta;
            }
        }
        return nominal + best;
    }

    /**
     * One render block.
     *
     * `input` and `output` are arrays of equal-length channel buffers. Consumes exactly as many
     * input samples as it produces output ones, which is what makes this safe to run for ever: a
     * stretcher that consumed at a different rate than it produced would either starve or grow a
     * buffer without bound, and both of those are the usual reason this is called hard.
     */
    process(input, output, pitch) {
        const frames = output[0]?.length ?? 0;
        if (!frames) return;
        this.pitch = pitch;

        for (let index = 0; index < frames; index += 1) {
            for (let channel = 0; channel < this.rings.length; channel += 1) {
                const source = input[channel] ?? input[0];
                this.rings[channel][this.written % RING] = source ? source[index] : 0;
            }
            this.written += 1;

            // Nothing to read until the pointer has its lag behind it. The arithmetic is written so
            // the delay is exactly LAG and not one sample under it: `written` counts the sample
            // just stored, so the position LAG samples back is `written - 1 - LAG`.
            if (!this.primed) {
                if (this.written <= LAG) {
                    for (const channel of output) channel[index] = 0;
                    continue;
                }
                this.primed = true;
                this.read = this.written - 1 - LAG;
            }

            if (this.untilSplice <= 0) {
                this.untilSplice = SEQ;
                const drift = this.written - this.read - LAG;
                if (Math.abs(drift) > DEAD_ZONE && this.fading <= 0) {
                    this.readOut = this.read;
                    this.read += this.bestOffset(drift);
                    this.fading = XFADE;
                }
            }

            for (let channel = 0; channel < output.length; channel += 1) {
                const fresh = this.at(channel, this.read);
                if (this.fading > 0) {
                    // Equal-power across the splice, so the join does not dip.
                    const progress = 1 - this.fading / XFADE;
                    const angle = progress * (Math.PI / 2);
                    output[channel][index] = this.at(channel, this.readOut) * Math.cos(angle)
                        + fresh * Math.sin(angle);
                } else {
                    output[channel][index] = fresh;
                }
            }

            this.read += this.pitch;
            if (this.fading > 0) {
                this.readOut += this.pitch;
                this.fading -= 1;
            }
            this.untilSplice -= 1;
        }
    }
}

/** How far behind the input this node's output runs, in seconds at a given rate. */
export const tempoBendLatencySec = (sampleRate) => LAG / sampleRate;

// Only inside a worklet. In the unit tests none of these globals exist, and the class above is the
// entire thing worth testing.
if (typeof registerProcessor === 'function' && typeof AudioWorkletProcessor === 'function') {
    class TempoBendProcessor extends AudioWorkletProcessor {
        static get parameterDescriptors() {
            return [{
                name: 'pitch',
                defaultValue: 1,
                minValue: 0.5,
                maxValue: 2,
                automationRate: 'k-rate',
            }];
        }

        constructor() {
            super();
            this.bend = null;
        }

        process(inputs, outputs, parameters) {
            const input = inputs[0] ?? [];
            const output = outputs[0] ?? [];
            if (!output.length) return true;
            if (!this.bend || this.bend.rings.length !== output.length) {
                this.bend = new TempoBend(output.length);
            }
            this.bend.process(input, output, parameters.pitch[0]);
            return true;
        }
    }
    registerProcessor('automix-tempo-bend', TempoBendProcessor);
}
