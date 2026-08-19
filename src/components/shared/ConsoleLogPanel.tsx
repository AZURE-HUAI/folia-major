import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
    clearConsoleLog,
    formatConsoleLog,
    getConsoleLogEntries,
    subscribeToConsoleLog,
    type ConsoleLevel,
    type ConsoleLogEntry,
} from '../../utils/consoleLogBuffer';
import { readConsoleLogFilters, writeConsoleLogFilters } from '../../utils/consoleLogFilters';

// src/components/shared/ConsoleLogPanel.tsx
// The session log, narrowed down to the part worth reading. Shared by the player's debug overlay
// and the Developer settings page - one panel, so a log surface added later inherits the filters,
// the selection and the copy behaviour instead of reimplementing a list.
//
// Nobody opens a log to read a log. They open it having just seen something go wrong, and every
// second between opening it and finding the line that explains the problem is wasted. Three things
// account for nearly all of that time, and this panel is built around them:
//
// - The line is buried in noise. One prefetch pass writes forty lines saying it had nothing to do,
//   between the two lines somebody came here for. So: mute by module and by level, and remember it,
//   because the noise is the same noise next session.
// - You cannot tell what is missing. So: every module carries a count and the header says how many
//   lines the filters are hiding. A filtered view that silently drops the answer is worse than noise.
// - Reading it is not the point; handing it over is. So: pick the lines that matter and copy those,
//   rather than a thousand lines somebody else now has to triage.

const CONSOLE_LEVELS: ConsoleLevel[] = ['log', 'info', 'warn', 'error', 'debug'];
/** Lines with no `[Module]` prefix. Grouped under one name so they filter like everything else. */
const UNSCOPED = '(untagged)';

interface ConsoleLogPanelProps {
    isDaylight: boolean;
    /** Wrapper classes, so the host decides how the panel sits in its own page. */
    className?: string;
    /** Tailwind max-height for the list. The overlay is cramped; a settings page is not. */
    listMaxHeightClass?: string;
}

const Pill: React.FC<{
    label: string;
    isActive: boolean;
    onClick: () => void;
    isDaylight: boolean;
}> = ({ label, isActive, onClick, isDaylight }) => {
    const baseClass = isDaylight
        ? 'border-black/10 hover:bg-black/[0.05]'
        : 'border-white/10 hover:bg-white/[0.07]';
    const activeClass = isDaylight ? 'bg-black/[0.08] text-zinc-950' : 'bg-white/[0.12] text-white';
    return (
        <button
            type="button"
            onClick={onClick}
            className={`rounded-full border px-3 py-1.5 text-[10px] uppercase tracking-[0.18em] transition-colors ${baseClass} ${isActive ? activeClass : 'opacity-75'}`}
        >
            {label}
        </button>
    );
};

/**
 * A filter as one line that opens into a list.
 *
 * Laid out inline rather than as a floating popover on purpose: this panel is hosted inside two
 * different scroll containers, and an absolutely positioned menu gets clipped by whichever one has
 * the overflow. Pushing the page down cannot be clipped by anything.
 */
const FilterMenu: React.FC<{
    label: string;
    summary: string;
    isDaylight: boolean;
    children: React.ReactNode;
}> = ({ label, summary, isDaylight, children }) => {
    const [isOpen, setIsOpen] = useState(false);
    const frameClass = isDaylight
        ? 'border-black/10 bg-black/[0.03] hover:bg-black/[0.05]'
        : 'border-white/10 bg-white/[0.04] hover:bg-white/[0.07]';
    // An open menu takes the whole row: the pills are the content, and squeezing a dozen of them
    // into half the width is the crush this replaced.
    return (
        <div className={`min-w-0 flex-1 ${isOpen ? 'basis-full' : ''}`}>
            <button
                type="button"
                onClick={() => setIsOpen(open => !open)}
                aria-expanded={isOpen}
                className={`flex w-full items-center justify-between gap-2 rounded-md border px-2 py-1 text-[10px] uppercase tracking-[0.14em] transition-colors ${frameClass}`}
            >
                <span className="truncate">{label}</span>
                <span className="flex shrink-0 items-center gap-1 opacity-60">
                    {summary}
                    <span aria-hidden="true">{isOpen ? '▴' : '▾'}</span>
                </span>
            </button>
            {isOpen && <div className="flex flex-wrap gap-1.5 pt-2">{children}</div>}
        </div>
    );
};

export const ConsoleLogPanel: React.FC<ConsoleLogPanelProps> = ({
    isDaylight,
    className = '',
    listMaxHeightClass = 'max-h-[26rem]',
}) => {
    const entries = useSyncExternalStore(subscribeToConsoleLog, getConsoleLogEntries);
    const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
    const [query, setQuery] = useState('');
    const [hiddenScopes, setHiddenScopes] = useState<Set<string>>(
        () => new Set(readConsoleLogFilters().hiddenScopes),
    );
    const [hiddenLevels, setHiddenLevels] = useState<Set<ConsoleLevel>>(
        () => new Set(readConsoleLogFilters().hiddenLevels),
    );
    const [selected, setSelected] = useState<Set<number>>(() => new Set());
    /** Where a shift-click measures its range from - the last line clicked without a modifier. */
    const anchorRef = useRef<number | null>(null);

    useEffect(() => {
        writeConsoleLogFilters({
            hiddenScopes: [...hiddenScopes],
            hiddenLevels: [...hiddenLevels],
        });
    }, [hiddenLevels, hiddenScopes]);

    // Every module the session has produced, with how much of the log each accounts for. The counts
    // are the point: they are what tells you which one to mute to get your log back.
    const scopeCounts = useMemo(() => {
        const counts = new Map<string, number>();
        entries.forEach(entry => {
            const scope = entry.scope ?? UNSCOPED;
            counts.set(scope, (counts.get(scope) ?? 0) + 1);
        });
        return [...counts.entries()].sort((a, b) => b[1] - a[1]);
    }, [entries]);

    const visible = useMemo(() => {
        const needle = query.trim().toLowerCase();
        return entries.filter(entry => {
            if (hiddenLevels.has(entry.level)) return false;
            if (hiddenScopes.has(entry.scope ?? UNSCOPED)) return false;
            return needle === '' || entry.text.toLowerCase().includes(needle);
        });
    }, [entries, hiddenLevels, hiddenScopes, query]);

    // A selection is a set of lines picked out of a view. Change the view and it becomes a set of
    // lines nobody can see any more - which then quietly copies itself instead of what is on
    // screen. Dropping it is the only behaviour that never lies about what Copy will produce.
    useEffect(() => {
        setSelected(new Set());
        anchorRef.current = null;
    }, [hiddenLevels, hiddenScopes, query]);

    const toggle = <T,>(set: Set<T>, value: T): Set<T> => {
        const next = new Set(set);
        if (!next.delete(value)) next.add(value);
        return next;
    };

    const handleRowClick = (entry: ConsoleLogEntry, event: React.MouseEvent) => {
        if (event.shiftKey && anchorRef.current !== null) {
            // Ranges run over what is ON SCREEN, not over the buffer: picking two lines either side
            // of a filtered-out block should hand you the block you can see between them.
            const from = visible.findIndex(item => item.id === anchorRef.current);
            const to = visible.findIndex(item => item.id === entry.id);
            if (from >= 0 && to >= 0) {
                const [start, end] = from < to ? [from, to] : [to, from];
                setSelected(new Set(visible.slice(start, end + 1).map(item => item.id)));
                return;
            }
        }
        anchorRef.current = entry.id;
        if (event.ctrlKey || event.metaKey) {
            setSelected(current => toggle(current, entry.id));
            return;
        }
        // A plain click on the only selected line clears it, so getting out of a selection does not
        // need a button anyone has to find first.
        setSelected(current => (current.size === 1 && current.has(entry.id) ? new Set() : new Set([entry.id])));
    };

    const copyTarget = selected.size > 0 ? visible.filter(entry => selected.has(entry.id)) : visible;

    const handleCopy = async () => {
        try {
            await navigator.clipboard.writeText(formatConsoleLog(copyTarget));
            setCopyState('copied');
        } catch {
            setCopyState('failed');
        }
        window.setTimeout(() => setCopyState('idle'), 1500);
    };

    const levelClass = (level: ConsoleLevel) => {
        if (level === 'error') return isDaylight ? 'text-rose-700' : 'text-rose-300';
        if (level === 'warn') return isDaylight ? 'text-amber-700' : 'text-amber-300';
        return 'opacity-75';
    };
    const selectedClass = isDaylight ? 'bg-black/[0.09]' : 'bg-white/[0.14]';
    const inputClass = isDaylight
        ? 'border-black/10 bg-black/[0.03] placeholder:text-black/35'
        : 'border-white/10 bg-white/[0.05] placeholder:text-white/35';

    const hiddenCount = entries.length - visible.length;
    const mutedLevels = hiddenLevels.size;
    const mutedScopes = scopeCounts.filter(([scope]) => hiddenScopes.has(scope)).length;

    return (
        <section className={className}>
            <div className="flex items-center justify-between gap-2 px-3 pt-3">
                <div className="text-[10px] uppercase tracking-[0.16em] opacity-60">
                    Console ({visible.length}
                    {hiddenCount > 0 ? ` of ${entries.length}` : ''}
                    {selected.size > 0 ? `, ${selected.size} picked` : ''})
                </div>
                <div className="flex gap-2">
                    <Pill
                        label={
                            copyState === 'copied' ? 'Copied'
                                : copyState === 'failed' ? 'Failed'
                                    : selected.size > 0 ? `Copy ${selected.size}` : `Copy ${visible.length}`
                        }
                        isActive={selected.size > 0}
                        onClick={() => { void handleCopy(); }}
                        isDaylight={isDaylight}
                    />
                    <Pill label="Clear" isActive={false} onClick={clearConsoleLog} isDaylight={isDaylight} />
                </div>
            </div>

            <div className="flex flex-col gap-2 px-3 pt-2">
                <input
                    type="search"
                    value={query}
                    onChange={event => setQuery(event.target.value)}
                    placeholder="Search this session's log"
                    className={`w-full rounded-md border px-2 py-1 text-[11px] outline-none transition-colors focus:border-current ${inputClass}`}
                />
                <div className="flex flex-wrap items-start gap-2">
                    <FilterMenu
                        label="Level"
                        summary={mutedLevels === 0 ? 'all' : `${CONSOLE_LEVELS.length - mutedLevels}/${CONSOLE_LEVELS.length}`}
                        isDaylight={isDaylight}
                    >
                        {CONSOLE_LEVELS.map(level => (
                            <Pill
                                key={level}
                                label={level}
                                isActive={!hiddenLevels.has(level)}
                                onClick={() => setHiddenLevels(current => toggle(current, level))}
                                isDaylight={isDaylight}
                            />
                        ))}
                    </FilterMenu>
                    <FilterMenu
                        label="Module"
                        summary={
                            scopeCounts.length === 0 ? 'none yet'
                                : mutedScopes === 0 ? 'all'
                                    : `${scopeCounts.length - mutedScopes}/${scopeCounts.length}`
                        }
                        isDaylight={isDaylight}
                    >
                        {/* All and None first: narrowing to one module out of a dozen is the common
                            move, and doing it by unpicking the other eleven is not a filter. */}
                        <Pill
                            label="All"
                            isActive={false}
                            onClick={() => setHiddenScopes(new Set())}
                            isDaylight={isDaylight}
                        />
                        <Pill
                            label="None"
                            isActive={false}
                            onClick={() => setHiddenScopes(new Set(scopeCounts.map(([scope]) => scope)))}
                            isDaylight={isDaylight}
                        />
                        <span className="mx-0.5 h-4 w-px shrink-0 self-center bg-current opacity-15" />
                        {scopeCounts.map(([scope, count]) => (
                            <Pill
                                key={scope}
                                label={`${scope} ${count}`}
                                isActive={!hiddenScopes.has(scope)}
                                onClick={() => setHiddenScopes(current => toggle(current, scope))}
                                isDaylight={isDaylight}
                            />
                        ))}
                    </FilterMenu>
                </div>
            </div>

            {visible.length === 0 ? (
                <div className="px-3 pb-3 pt-2 text-[11px] opacity-70">
                    {entries.length === 0
                        ? 'Nothing logged yet.'
                        : `Nothing matches. ${entries.length} lines are hidden by the filters above.`}
                </div>
            ) : (
                // column-reverse over a reversed list, so the newest line is pinned to the bottom by
                // the scroll container itself. Scrolling up to read then stays put as lines arrive,
                // which no amount of scrollTop bookkeeping manages reliably.
                <div className={`mt-2 flex ${listMaxHeightClass} select-none flex-col-reverse overflow-y-auto overscroll-contain px-1 pb-2`}>
                    {visible.slice().reverse().map(entry => (
                        <div
                            key={entry.id}
                            onClick={event => handleRowClick(entry, event)}
                            className={`flex cursor-pointer gap-2 rounded px-2 py-[3px] text-[10px] leading-4 ${levelClass(entry.level)} ${selected.has(entry.id) ? selectedClass : ''}`}
                        >
                            <span className="shrink-0 tabular-nums opacity-50">
                                {new Date(entry.at).toLocaleTimeString()}
                            </span>
                            <span className="whitespace-pre-wrap break-all">{entry.text}</span>
                        </div>
                    ))}
                </div>
            )}
        </section>
    );
};

export default ConsoleLogPanel;
