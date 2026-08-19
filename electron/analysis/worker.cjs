const path = require('path');
const fs = require('fs');
const os = require('os');

// electron/analysis/worker.cjs
// Both ONNX models, in a process that owns no window.
//
// This file exists because of one measured fact about onnxruntime-node: its `run()` LOOKS async and
// is not. The JS wrapper is `new Promise(resolve => setImmediate(() => resolve(session.run(...))))`,
// and `session.run` there is a synchronous N-API call - so `setImmediate` only decides which tick
// the block starts on, never that it is a block. Measured with a 10ms interval timer around one
// htdemucs segment: 1 tick fired where 150 were due, and 0 of 361 during the model load.
//
// In the main process that is fatal rather than slow. The main process owns the window's message
// loop and every ipcMain handler, so a blocked event loop is a window Windows paints as "not
// responding" and a renderer whose every `invoke` is queued behind the transformer. A 30s window is
// six segments, a transition needs two windows, and the session reloads between tracks: about
// twenty seconds of frozen UI per track, which is exactly the symptom that sent us looking.
//
// So the models live here, reached over `utilityProcess`. Nothing in this file may require
// 'electron' - it is plain Node, and the models directory arrives as argv.
//
// The second measured fact is in THREADS below.

const MODELS_DIR = process.argv[2] || '';

/**
 * How many cores inference may use.
 *
 * Not a timidity knob - the default is measured to be SLOWER. onnxruntime's default intra-op pool
 * is one thread per logical core, and on this 24-core machine that ran a segment in 3547ms against
 * 1438ms at twelve threads: the pool spends its time contending with itself. Measured, per segment:
 *
 *   default(24)  3547ms  51% of the machine        4  1873ms  32%
 *   12           1438ms  66%                       2  2908ms  19%
 *   6            1602ms  42%
 *
 * A quarter of the cores, because the number that matters is the FRACTION of the machine left for
 * the renderer's frames and the audio thread, and that fraction should not depend on how big the
 * machine is. Separation has minutes of lead time and no deadline; it does not need to be fast, it
 * needs to be invisible.
 */
const THREADS = Math.max(1, Math.floor(os.cpus().length / 4));

const sessions = new Map();
/** Set per model once loading has been tried and failed, so a broken install is reported once. */
const unavailable = new Map();

const load = async (name) => {
    if (sessions.has(name)) return sessions.get(name);
    if (unavailable.has(name)) return null;

    const file = path.join(MODELS_DIR, `${name}.onnx`);
    if (!fs.existsSync(file)) {
        unavailable.set(name, `no weights at ${file}`);
        console.warn(`[${name}] no weights at ${file} - the renderer falls back to its estimators`);
        return null;
    }
    try {
        const ort = require('onnxruntime-node');
        const session = await ort.InferenceSession.create(file, {
            // The single most important line for htdemucs. Measured on that graph: the default
            // arena takes peak RSS to 5190MB, and switching it off takes the SAME work to 530MB.
            // Five gigabytes beside an Electron renderer is not a slow app, it is a machine that
            // starts swapping.
            enableCpuMemArena: false,
            intraOpNumThreads: THREADS,
        });
        sessions.set(name, session);
        console.log(`[${name}] weights loaded (${THREADS} threads)`);
        return session;
    } catch (error) {
        unavailable.set(name, error?.message || String(error));
        console.warn(`[${name}] could not start: ${unavailable.get(name)}`);
        return null;
    }
};

// ---------------------------------------------------------------------------- Beat This!
//
// Everything that can be reasoned about without a model - the spectrogram, the chunking, the peak
// picking - lives in src/services/automix/beatThis.ts where the unit tests can reach it. What is
// here is what needs a native runtime and an 83MB file, and nothing else.

/** Frames the export accepts in one call; a longer tensor fails inside the attention block. */
const MAX_CHUNK_FRAMES = 1500;
const MEL_BANDS = 128;

const runBeatThis = async (chunks) => {
    const session = await load('beat_this');
    if (!session) return null;
    if (!Array.isArray(chunks) || !chunks.length) return null;

    const ort = require('onnxruntime-node');
    const beat = [];
    const downbeat = [];
    for (const chunk of chunks) {
        const frames = Number(chunk?.frames);
        const data = chunk?.data;
        // The renderer is trusted, but a shape mismatch here is a native crash rather than an
        // exception - so the one thing that would cause it is checked rather than assumed.
        if (!Number.isInteger(frames) || frames <= 0 || frames > MAX_CHUNK_FRAMES) return null;
        if (!data || data.length !== frames * MEL_BANDS) return null;

        const input = new ort.Tensor('float32', Float32Array.from(data), [1, frames, MEL_BANDS]);
        const output = await session.run({ input_spectrogram: input });
        // Copied out of the tensors: their buffers belong to the runtime and are not ours to send.
        beat.push(new Float32Array(output.beat.data));
        downbeat.push(new Float32Array(output.downbeat.data));
    }
    return { beat, downbeat };
};

// ---------------------------------------------------------------------------- htdemucs
//
// Raw stereo float at 44.1kHz in, raw stereo float out. No spectrogram, no normalisation, nothing
// to get wrong. The entire contract is the segment length, the stem order and the overlap-add, all
// three read off the reference implementation (demucs_onnx 0.3.4, `_chunked_separate_single`).

/** Baked into the export at 7.8s. A different length is a different graph, not a parameter. */
const SEGMENT = 343980;
const MODEL_RATE = 44100;
/** The model's own row order. Reading a row as the wrong stem is silent and total. */
const SOURCES = ['drums', 'bass', 'other', 'vocals'];
/** What we send back. `other` is left out on purpose - see the note in stems.ts. */
const RETURNED = ['drums', 'bass', 'vocals'];
/**
 * Longest window we will separate in one request.
 *
 * Forty seconds covers the longest overlap the planner can ask for (25s) plus the room either side
 * a placement search needs. It is also the memory bound: the reply carries three stereo stems, so
 * the renderer receives about 42MB per track, and two tracks are in flight during a transition.
 */
const MAX_SAMPLES = 40 * MODEL_RATE;

/**
 * The reference's triangular overlap-add window.
 *
 * Chunks step by three quarters of a segment and each one is faded in and out across the quarter it
 * shares with its neighbour, then the sum is divided by the total weight. Not a smoothing choice -
 * it is what demucs does internally, and a chunk boundary without it is an audible seam.
 */
let hann = null;
const buildWindow = () => {
    const overlap = Math.floor(SEGMENT / 4);
    const win = new Float32Array(SEGMENT).fill(1);
    for (let i = 0; i < overlap; i += 1) {
        const v = i / (overlap - 1);
        win[i] = v;
        win[SEGMENT - 1 - i] = v;
    }
    return win;
};

const runHtdemucs = async (request) => {
    const left = request?.left;
    const right = request?.right;
    // A shape mismatch reaches the native runtime as a crash rather than an exception, so the one
    // thing that would cause it is checked rather than assumed.
    if (!left || !right || left.length !== right.length) return null;
    if (!left.length || left.length > MAX_SAMPLES) return null;

    const session = await load('htdemucs');
    if (!session) return null;

    const ort = require('onnxruntime-node');
    const total = left.length;
    if (!hann) hann = buildWindow();
    const overlap = Math.floor(SEGMENT / 4);
    const stride = SEGMENT - overlap;
    const chunks = Math.max(1, Math.ceil(total / stride));

    const out = SOURCES.map(() => [new Float32Array(total), new Float32Array(total)]);
    const weight = new Float32Array(total);
    const input = new Float32Array(2 * SEGMENT);

    for (let c = 0; c < chunks; c += 1) {
        const start = c * stride;
        const end = Math.min(start + SEGMENT, total);
        if (end <= start) break;
        input.fill(0);
        for (let i = start; i < end; i += 1) {
            input[i - start] = left[i];
            input[SEGMENT + i - start] = right[i];
        }
        const result = await session.run({ mix: new ort.Tensor('float32', input, [1, 2, SEGMENT]) });
        const stems = result.stems.data;                       // [1, 4, 2, SEGMENT]
        for (let s = 0; s < SOURCES.length; s += 1) {
            for (let ch = 0; ch < 2; ch += 1) {
                const base = (s * 2 + ch) * SEGMENT;
                const dst = out[s][ch];
                for (let i = start; i < end; i += 1) dst[i] += stems[base + i - start] * hann[i - start];
            }
        }
        for (let i = start; i < end; i += 1) weight[i] += hann[i - start];
    }

    for (let i = 0; i < total; i += 1) {
        const w = Math.max(weight[i], 1e-8);
        for (const stem of out) { stem[0][i] /= w; stem[1][i] /= w; }
    }

    const reply = {};
    for (const name of RETURNED) {
        const row = out[SOURCES.indexOf(name)];
        reply[name] = { left: row[0], right: row[1] };
    }
    return reply;
};

// ---------------------------------------------------------------------------- dispatch

const HANDLERS = { 'beat-this': runBeatThis, htdemucs: runHtdemucs };

/**
 * One at a time, across BOTH models.
 *
 * The pool above is already sized to leave the machine usable; two inferences at once would double
 * that share and hold two models' weights at once.
 */
let queue = Promise.resolve();

process.parentPort.on('message', ({ data }) => {
    const { id, kind, payload } = data || {};
    const handler = HANDLERS[kind];
    const run = queue.then(async () => {
        if (!handler) return null;
        const started = Date.now();
        const result = await handler(payload);
        if (result) console.log(`[${kind}] done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
        return result;
    }).catch((error) => {
        console.warn(`[${kind}] failed`, error);
        return null;
    });
    // The queue must not inherit a rejection, or one failure poisons every later request.
    queue = run.then(() => undefined, () => undefined);
    run.then(result => process.parentPort.postMessage({ id, result: result ?? null }));
});
