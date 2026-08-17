// src/utils/consoleLogBuffer.ts
// Keeps the last few hundred console lines in memory, so the debug overlay can show them.
//
// The packaged desktop build has no console at all: DevTools are only opened automatically under
// ELECTRON_DEV, and the window is frameless, so there is no menu left to toggle them from. Every
// diagnosis of a playback problem starts with what the app logged while it was running, and on the
// desktop build that was simply unavailable - the only way to read it was to run the web build
// instead, which is a different runtime from the one with the problem in it.

export type ConsoleLevel = 'log' | 'info' | 'warn' | 'error' | 'debug';

export interface ConsoleLogEntry {
    id: number;
    at: number;
    level: ConsoleLevel;
    text: string;
}

/** Bounded, because this runs for the whole life of the app and a long session logs a lot. */
const LIMIT = 1000;

let entries: ConsoleLogEntry[] = [];
let nextId = 0;
const listeners = new Set<() => void>();

/**
 * One console argument as a line of text.
 *
 * Never throws, and that is the whole requirement: this runs *inside* console, so anything escaping
 * here would take down a call site whose only crime was logging. Circular structures are the normal
 * case rather than the exception - DOM nodes, audio nodes, React fibers - and JSON.stringify
 * refuses those outright.
 */
const format = (value: unknown): string => {
    if (typeof value === 'string') return value;
    if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`;
    try {
        const seen = new WeakSet<object>();
        return JSON.stringify(value, (_key, item: unknown) => {
            if (typeof item !== 'object' || item === null) return item;
            if (seen.has(item)) return '[circular]';
            seen.add(item);
            return item;
        }) ?? String(value);
    } catch {
        return String(value);
    }
};

const push = (level: ConsoleLevel, args: unknown[]) => {
    // A new array rather than a mutated one: useSyncExternalStore compares snapshots by identity,
    // and a buffer changed in place would leave the panel rendering a list it thinks is current.
    entries = entries.concat({
        id: nextId += 1,
        at: Date.now(),
        level,
        text: args.map(format).join(' '),
    });
    if (entries.length > LIMIT) entries = entries.slice(entries.length - LIMIT);
    listeners.forEach(listener => listener());
};

export const getConsoleLogEntries = () => entries;

export const subscribeToConsoleLog = (listener: () => void) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
};

export const clearConsoleLog = () => {
    entries = [];
    listeners.forEach(listener => listener());
};

/** The whole buffer as plain text, which is the form it is useful in outside the app. */
export const formatConsoleLog = () => entries
    .map(entry => `${new Date(entry.at).toLocaleTimeString()} [${entry.level}] ${entry.text}`)
    .join('\n');

let installed = false;

/** Call once, as early as possible - anything logged before this is not recorded. */
export const installConsoleLogCapture = () => {
    if (installed) return;
    installed = true;

    (['log', 'info', 'warn', 'error', 'debug'] as const).forEach(level => {
        const original = console[level].bind(console);
        console[level] = (...args: unknown[]) => {
            push(level, args);
            original(...args);
        };
    });

    // Out of console's reach: an exception nobody caught is printed by the browser itself, not
    // through console, so patching console alone would leave the panel blank for exactly the
    // failure worth reading.
    window.addEventListener('error', event => push('error', [event.error ?? event.message]));
    window.addEventListener('unhandledrejection', event => push('error', ['Unhandled rejection:', event.reason]));
};
