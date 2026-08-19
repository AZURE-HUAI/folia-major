import React, { useSyncExternalStore } from 'react';
import { ScrollText } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Theme } from '../../../types';
import {
    getConsoleLogEntries,
    isConsoleCaptureEnabled,
    setConsoleCaptureEnabled,
    subscribeToConsoleLog,
} from '../../../utils/consoleLogBuffer';
import ConsoleLogPanel from '../../shared/ConsoleLogPanel';

// src/components/modal/settings/DeveloperSettingsSubview.tsx
// The session log, out from behind the player-only debug chord.
//
// The buffer exists because the packaged desktop build has no console: DevTools only open under
// ELECTRON_DEV and the window is frameless, so there is no menu to reach them from. Until now the
// only way in was Alt+Shift+D on the player page, which is a thing you have to be told. A settings
// page is where someone looks when they want to know what the app is doing.

type DeveloperSettingsSubviewProps = {
    isDaylight: boolean;
    settingsCardClass: string;
    theme?: Theme;
    toggleOffBackgroundClass: string;
};

const DeveloperSettingsSubview: React.FC<DeveloperSettingsSubviewProps> = ({
    isDaylight,
    settingsCardClass,
    theme,
    toggleOffBackgroundClass,
}) => {
    const { t } = useTranslation();
    // Subscribed rather than read once: the switch clears the buffer, and the count beside it has
    // to answer for that immediately or it reads as the switch having done nothing.
    const entries = useSyncExternalStore(subscribeToConsoleLog, getConsoleLogEntries);
    const capturing = isConsoleCaptureEnabled();

    return (
        <div className="space-y-4">
            <div className={`rounded-2xl border p-4 space-y-4 ${settingsCardClass}`}>
                <div className="flex items-center justify-between gap-4">
                    <div className="flex min-w-0 items-start gap-3">
                        <div className="p-2 rounded-lg opacity-60 shrink-0">
                            <ScrollText size={14} />
                        </div>
                        <div className="min-w-0 space-y-1">
                            <div className="flex items-center gap-2">
                                <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                                    {t('options.consoleLogCapture') || 'Session log'}
                                </span>
                                {/* The same log is a keystroke away on the player page, and nobody
                                    finds a chord that is never written down. */}
                                <kbd
                                    className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-normal tracking-wide ${isDaylight ? 'border-black/10 bg-black/[0.04]' : 'border-white/10 bg-white/[0.06]'}`}
                                    style={{ color: 'var(--text-secondary)' }}
                                >
                                    Alt+Shift+D
                                </kbd>
                            </div>
                            <div className="text-xs opacity-50" style={{ color: 'var(--text-secondary)' }}>
                                {t('options.consoleLogCaptureDesc')
                                    || 'Keep what the app logs while it runs, so a problem can be read back and handed over.'}
                            </div>
                        </div>
                    </div>
                    <button
                        type="button"
                        onClick={() => setConsoleCaptureEnabled(!capturing)}
                        aria-pressed={capturing}
                        className={`w-12 h-6 shrink-0 rounded-full p-1 transition-colors ${!capturing ? toggleOffBackgroundClass : ''}`}
                        style={{ backgroundColor: capturing ? theme?.secondaryColor || 'rgba(114, 119, 134, 1)' : undefined }}
                    >
                        <div className={`w-4 h-4 rounded-full bg-white shadow-sm transition-transform ${capturing ? 'translate-x-6' : 'translate-x-0'}`} />
                    </button>
                </div>

                {/* Rendered either way: the panel answers for the switch itself, so this page and
                    the Alt+Shift+D overlay cannot disagree about whether anything is being kept. */}
                <ConsoleLogPanel
                    isDaylight={isDaylight}
                    className={`rounded-xl border ${isDaylight ? 'border-black/10 bg-black/[0.03]' : 'border-white/10 bg-black/15'}`}
                    listMaxHeightClass="max-h-[22rem]"
                />
            </div>

            <div className="text-[11px] leading-relaxed opacity-45" style={{ color: 'var(--text-secondary)' }}>
                {t('options.consoleLogConvention')
                    || 'Lines are grouped by the [Module] prefix they start with, so anything logged as console.log(\'[YourModule] …\') can be filtered on its own. See docs/client-logging.md.'}
                {' '}
                {entries.length > 0 ? `(${entries.length})` : null}
            </div>
        </div>
    );
};

export default DeveloperSettingsSubview;
