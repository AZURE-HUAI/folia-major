const path = require('path');

// electron/analysis/host.cjs
// The main process's half of the analysis worker: spawn it, correlate replies, kill it when idle.
//
// Deliberately the thinnest thing that can sit here. Every decision about the models is in
// worker.cjs, and the reason they are not in this process at all is at the top of that file.
//
// Restarting rather than releasing is the other half of that move. The old in-process version tried
// to give the 530MB back by dropping the session handle and hoping `global.gc()` existed, which in
// a normal build it does not. Killing a child process returns every byte, and the reload it costs
// is now several seconds of a background process rather than several seconds of a frozen window.

/**
 * How long the worker is kept with nothing to do.
 *
 * Two minutes: long enough that the two windows of one transition share a loaded session - they are
 * requested seconds apart - and short enough that a paused player is not holding half a gigabyte.
 * Tracks are minutes apart, so this does mean a reload per track, which is the trade being made.
 */
const IDLE_MS = 120_000;

/** Answer for a request whose worker died under it. Never leaves this file - see `ask`. */
const CRASHED = Symbol('crashed');

const createAnalysisHost = ({ app, ipcMain }) => {
    const modelsDir = path.join(
        app?.isPackaged ? process.resourcesPath : path.join(__dirname, '..', '..'),
        'models',
    );

    let child = null;
    let idleTimer = null;
    let quitting = false;
    let nextId = 0;
    const pending = new Map();

    const stop = () => {
        if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
        const dying = child;
        child = null;
        for (const resolve of pending.values()) resolve(CRASHED);
        pending.clear();
        if (dying) dying.kill();
    };

    const touch = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
            if (pending.size) { touch(); return; }
            console.log('[analysis] worker idle, stopping');
            stop();
        }, IDLE_MS);
        if (idleTimer.unref) idleTimer.unref();
    };

    const spawn = () => {
        if (child) return child;
        // Required here rather than at the top: this module is loaded during main's own startup,
        // and utilityProcess is only meaningful once the app is running.
        const { utilityProcess } = require('electron');
        const started = utilityProcess.fork(path.join(__dirname, 'worker.cjs'), [modelsDir], {
            // Piped and forwarded by hand. `inherit` is the documented default and on Windows it
            // silently drops the child's output, which for a subsystem whose only failure mode is
            // answering null means it fails invisibly - measured, not assumed: with `inherit` not
            // one of the worker's lines reached the terminal.
            stdio: 'pipe',
        });
        child = started;

        const forward = (stream) => stream?.on('data', (chunk) => {
            process.stdout.write(`[analysis] ${chunk}`);
        });
        forward(started.stdout);
        forward(started.stderr);

        started.on('message', ({ id, result }) => {
            const resolve = pending.get(id);
            if (!resolve) return;
            pending.delete(id);
            resolve(result ?? null);
        });
        started.on('exit', (code) => {
            // `stop` clears `child` first, so reaching here with this one still installed means it
            // died on its own. The app going away underneath it is not news.
            if (child !== started || quitting) return;
            console.warn(`[analysis] worker exited on its own (${code})`);
            stop();
        });
        return started;
    };

    const send = (kind, payload) => new Promise((resolve) => {
        const id = nextId += 1;
        pending.set(id, resolve);
        touch();
        spawn().postMessage({ id, kind, payload });
    });

    /**
     * One retry, and the reason is a contract rather than optimism.
     *
     * Both renderer modules treat a null answer as PERMANENT - "this build has no models" - and
     * stop asking for the rest of the session, which is right, because the ways a model declines
     * (not Electron, no weights, runtime will not start) do not heal. Putting the models in a child
     * process added a way to get null that does heal, so it is absorbed here instead of teaching
     * every caller a second kind of failure. A crash that repeats is answered null, as before.
     */
    const ask = async (kind, payload) => {
        let answer = await send(kind, payload);
        if (answer === CRASHED) answer = await send(kind, payload);
        return answer === CRASHED ? null : answer;
    };

    ipcMain.handle('automix-beat-this', (_event, chunks) => ask('beat-this', chunks));
    ipcMain.handle('automix-htdemucs', (_event, request) => ask('htdemucs', request));

    app?.on('will-quit', () => { quitting = true; stop(); });
};

module.exports = { createAnalysisHost };
