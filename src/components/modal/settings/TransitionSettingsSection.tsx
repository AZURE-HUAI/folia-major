import React from 'react';
import { Blend, Disc3, Waves } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import type { Theme } from '../../../types';
import { useSettingsUiStore } from '../../../stores/useSettingsUiStore';
import { CROSSFADE_MAX_SEC, CROSSFADE_MIN_SEC } from '../../../services/automix/crossfadePlanner';
import { canAnalyseTracks, type TransitionMode } from '../../../services/automix/transitionStrategy';
import { transitionCapabilities } from '../../../services/automix/stems';

// src/components/modal/settings/TransitionSettingsSection.tsx
// The Folia transition block on the playback options page: the master switch, the choice between
// the two strategies, and the one control that belongs to each.
//
// UI only. It reads the store and calls its actions; every question about what a mode DOES is
// answered in services/automix/transitionStrategy.ts. The two things it works out for itself -
// which mode is actually running, and whether this build is the full one - are both asked of the
// services rather than decided here.

type TransitionSettingsSectionProps = {
    isDaylight: boolean;
    settingsCardClass: string;
    theme?: Theme;
};

const TransitionSettingsSection: React.FC<TransitionSettingsSectionProps> = ({
    isDaylight,
    settingsCardClass,
    theme,
}) => {
    const { t } = useTranslation();
    const {
        automixEnabled,
        transitionMode,
        crossfadeMaxSec,
        enableMediaCache,
        onToggleAutomix,
        onSetTransitionMode,
        onSetCrossfadeMaxSec,
    } = useSettingsUiStore(useShallow(state => ({
        automixEnabled: state.automixEnabled,
        transitionMode: state.transitionMode,
        crossfadeMaxSec: state.crossfadeMaxSec,
        enableMediaCache: state.enableMediaCache,
        onToggleAutomix: state.handleToggleAutomix,
        onSetTransitionMode: state.handleSetTransitionMode,
        onSetCrossfadeMaxSec: state.handleSetCrossfadeMaxSec,
    })));

    const accentOutlineColor = theme?.accentColor || (isDaylight ? '#44403c' : '#f4f4f5');
    const toggleOffBackgroundClass = isDaylight ? 'bg-zinc-300/90' : 'bg-white/10';
    const rangeInputClass = `w-full accent-current ${isDaylight ? 'text-zinc-900' : 'text-white'}`;
    // Asked on every render rather than cached: it is a property lookup, and a cached answer would
    // be a second source of truth for a question whose whole job is to be the current one.
    const analysable = canAnalyseTracks();
    // Which of the two builds is running. Same reason it is not cached: the answer is the point.
    const capabilities = transitionCapabilities();

    const getAccentOptionStyle = (selected: boolean) => (
        selected
            ? {
                borderColor: accentOutlineColor,
                boxShadow: `inset 0 0 0 1px ${accentOutlineColor}`,
                backgroundColor: isDaylight ? `${accentOutlineColor}12` : `${accentOutlineColor}18`,
            }
            : {
                borderColor: isDaylight ? 'rgba(24, 24, 27, 0.12)' : 'rgba(255, 255, 255, 0.1)',
                backgroundColor: isDaylight ? 'rgba(255, 255, 255, 0.72)' : 'rgba(255, 255, 255, 0.05)',
            }
    );

    const modes: Array<{
        value: TransitionMode;
        icon: React.ReactNode;
        label: string;
        desc: string;
        disabled: boolean;
    }> = [
        {
            value: 'crossfade',
            icon: <Waves size={14} />,
            label: t('options.transitionCrossfade'),
            desc: t('options.transitionCrossfadeDesc'),
            disabled: false,
        },
        {
            value: 'automix',
            icon: <Disc3 size={14} />,
            label: t('options.transitionAutomix'),
            desc: t('options.transitionAutomixDesc'),
            disabled: !analysable,
        },
    ];

    // Which mode is actually running, which is not always the one that is selected: automix with no
    // way to measure a track degrades to the stable crossfade, and a setting that goes on claiming
    // otherwise is the failure this line exists to prevent.
    const effectiveMode: TransitionMode = transitionMode === 'automix' && !analysable
        ? 'crossfade'
        : transitionMode;

    const notice = !analysable
        ? t('options.transitionAutomixUnavailable')
        : !enableMediaCache
            ? t('options.transitionAutomixNeedsCache')
            : null;

    return (
        <section>
            <h3 className="text-sm font-bold uppercase tracking-wider opacity-50 mb-4 flex items-center gap-2" style={{ color: 'var(--text-secondary)' }}>
                <Blend size={14} /> {t('options.transitionSettings')}
            </h3>
            <div className={`rounded-xl border overflow-hidden ${settingsCardClass}`}>
                <div className="p-4 flex items-start justify-between gap-4">
                    <div className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                        {t('options.transitionEnable')}
                    </div>
                    <button
                        type="button"
                        onClick={() => onToggleAutomix(!automixEnabled)}
                        className={`w-12 h-6 rounded-full p-1 transition-colors shrink-0 ${automixEnabled ? '' : toggleOffBackgroundClass}`}
                        style={{ backgroundColor: automixEnabled ? theme?.secondaryColor || 'rgba(114, 119, 134, 1)' : undefined }}
                        aria-pressed={automixEnabled}
                        aria-label={t('options.transitionEnable')}
                    >
                        <div className={`w-4 h-4 rounded-full bg-white shadow-sm transition-transform ${automixEnabled ? 'translate-x-6' : 'translate-x-0'}`} />
                    </button>
                </div>

                <div
                    className={`p-4 space-y-3 border-t transition-opacity ${automixEnabled ? 'opacity-100' : 'opacity-45 pointer-events-none'}`}
                    style={{ borderColor: 'var(--border-primary, rgba(255,255,255,0.06))' }}
                >
                    <div className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                        {t('options.transitionMode')}
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        {modes.map((mode) => {
                            const selected = transitionMode === mode.value;
                            return (
                                <button
                                    key={mode.value}
                                    type="button"
                                    onClick={() => onSetTransitionMode(mode.value)}
                                    disabled={mode.disabled}
                                    className="rounded-xl border px-3 py-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-45"
                                    style={getAccentOptionStyle(selected)}
                                    aria-pressed={selected}
                                >
                                    <div className="text-sm font-medium flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
                                        {mode.icon}
                                        {mode.label}
                                        {selected && (
                                            <span
                                                className="ml-auto rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
                                                style={{ backgroundColor: `${accentOutlineColor}24`, color: 'var(--text-primary)' }}
                                            >
                                                {effectiveMode === mode.value
                                                    ? t('options.transitionActive')
                                                    : t('options.transitionFellBack')}
                                            </span>
                                        )}
                                    </div>
                                    <div className="mt-1 text-[11px] opacity-50" style={{ color: 'var(--text-secondary)' }}>
                                        {mode.desc}
                                    </div>
                                </button>
                            );
                        })}
                    </div>

                    {transitionMode === 'crossfade' ? (
                        <div className="space-y-3 pt-1">
                            <div className="flex items-center justify-between text-sm" style={{ color: 'var(--text-primary)' }}>
                                <span>{t('options.crossfadeMaxSeconds')}</span>
                                <span className="font-mono opacity-70 tabular-nums" style={{ color: 'var(--text-secondary)' }}>
                                    {t('options.crossfadeSecondsValue', { seconds: crossfadeMaxSec })}
                                </span>
                            </div>
                            <input
                                type="range"
                                min={CROSSFADE_MIN_SEC}
                                max={CROSSFADE_MAX_SEC}
                                step="1"
                                value={crossfadeMaxSec}
                                onChange={(event) => onSetCrossfadeMaxSec(Number(event.target.value))}
                                className={rangeInputClass}
                                aria-label={t('options.crossfadeMaxSeconds')}
                            />
                            <div className="flex justify-between text-[11px] font-mono opacity-60" style={{ color: 'var(--text-secondary)' }}>
                                <span>{t('options.crossfadeSecondsValue', { seconds: CROSSFADE_MIN_SEC })}</span>
                                <span>{t('options.crossfadeSecondsValue', { seconds: CROSSFADE_MAX_SEC })}</span>
                            </div>
                            <div className="text-[11px] opacity-50 max-w-[420px]" style={{ color: 'var(--text-secondary)' }}>
                                {t('options.crossfadeMaxSecondsDesc')}
                            </div>
                        </div>
                    ) : (
                        <div className="space-y-2 pt-1">
                            {/* Which build this is. The desktop app separates the two tracks and
                                hands them over stem by stem; the browser cannot run either model
                                and gets the same planner over less evidence. Said out loud because
                                the two sound different and nothing else would explain why. */}
                            <div
                                className="flex items-center gap-2 text-[11px]"
                                style={{ color: 'var(--text-secondary)' }}
                            >
                                <span
                                    className="rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide shrink-0"
                                    style={{
                                        backgroundColor: capabilities.full
                                            ? `${accentOutlineColor}24`
                                            : isDaylight ? 'rgba(24,24,27,0.08)' : 'rgba(255,255,255,0.08)',
                                        color: 'var(--text-primary)',
                                    }}
                                >
                                    {t(capabilities.full ? 'options.transitionEngineFull' : 'options.transitionEngineLite')}
                                </span>
                                <span className="opacity-60">
                                    {t(capabilities.full
                                        ? 'options.transitionEngineFullDesc'
                                        : 'options.transitionEngineLiteDesc')}
                                </span>
                            </div>
                            {notice && (
                                <div
                                    className="rounded-lg border px-3 py-2 text-[11px] leading-relaxed"
                                    style={{
                                        borderColor: isDaylight ? 'rgba(24, 24, 27, 0.12)' : 'rgba(255, 255, 255, 0.1)',
                                        color: 'var(--text-secondary)',
                                    }}
                                >
                                    {notice}
                                </div>
                            )}
                        </div>
                    )}
                </div>
            </div>
        </section>
    );
};

export default TransitionSettingsSection;
