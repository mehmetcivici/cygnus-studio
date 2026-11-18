import { Maximize2, Pause, Play, Sparkles, Trash2, ZoomIn, ZoomOut } from 'lucide-react';
import { fmtNumber, useI18n } from '../../i18n';
import { Badge, Button, IconButton, SegmentedControl, Select } from '../../ui';
import { useViewRev } from './hooks';
import { PERIOD_OPTIONS_US, WINDOW_OPTIONS_S, type ScopeMode } from './layout';
import { tScope } from './messages';
import type { ScopeView } from './view';

export interface ToolbarProps {
  view: ScopeView;
  mode: ScopeMode;
  onMode: (m: ScopeMode) => void;
  windowS: number;
  onWindow: (s: number) => void;
  periodUs: number;
  onPeriod: (us: number) => void;
  /** Fastest period any plotted board supports; faster options are disabled. */
  minPeriodUs: number;
  /** A plotted board is limited above the chosen period. */
  clamped: boolean;
  /** Effective stream periods in use, µs (for the status text). */
  streamPeriods: readonly number[];
  recommendedLabel: string | null;
  onRecommended: () => void;
  onClear: () => void;
  hasSignals: boolean;
}

export function fmtPeriod(us: number, lang: 'tr' | 'en'): string {
  return us >= 1000 ? `${fmtNumber(us / 1000, us % 1000 ? 1 : 0, { lang })} ms` : `${fmtNumber(us, 0, { lang })} µs`;
}

function fmtWindow(s: number): string {
  return s >= 60 ? `${s / 60} ${tScope('unitMin')}` : `${s} ${tScope('unitSec')}`;
}

export function Toolbar(p: ToolbarProps) {
  const { lang } = useI18n();
  useViewRev(p.view);
  const { view } = p;
  const fastest = p.streamPeriods.length ? Math.min(...p.streamPeriods) : null;
  return (
    <div className="scope-toolbar">
      <SegmentedControl<ScopeMode>
        size="sm"
        value={p.mode}
        onChange={p.onMode}
        ariaLabel={tScope('mode')}
        options={[
          { value: 'normal', label: tScope('modeNormal'), title: tScope('modeNormalHint') },
          { value: 'fast', label: tScope('modeFast'), title: tScope('modeFastHint') },
        ]}
      />
      {p.mode === 'fast' && (
        <>
          <Select<number>
            size="sm"
            value={p.periodUs}
            onChange={p.onPeriod}
            ariaLabel={tScope('period')}
            options={PERIOD_OPTIONS_US.map((us) => ({ value: us, label: `${tScope('period')} ${fmtPeriod(us, lang)}`, disabled: us < p.minPeriodUs }))}
          />
          {fastest !== null && (
            <Badge tone={p.clamped ? 'warn' : 'accent'} size="sm" title={p.clamped ? tScope('periodClamped') : undefined}>
              {fmtNumber(1e6 / fastest, 0, { lang })} Hz
              {p.clamped ? ` · ${tScope('boardLimit')}` : ''}
            </Badge>
          )}
        </>
      )}
      <span className="scope-toolbar__sep" />
      <Select<number>
        size="sm"
        value={p.windowS}
        onChange={p.onWindow}
        ariaLabel={tScope('window')}
        options={WINDOW_OPTIONS_S.map((s) => ({ value: s, label: `${tScope('window')} ${fmtWindow(s)}` }))}
      />
      <IconButton size="sm" icon={ZoomIn} label={tScope('zoomIn')} onClick={() => view.zoom(0.5, Number.NaN)} />
      <IconButton size="sm" icon={ZoomOut} label={tScope('zoomOut')} onClick={() => view.zoom(2, Number.NaN)} />
      <IconButton
        size="sm"
        icon={Maximize2}
        label={tScope('resetView')}
        onClick={() => {
          view.setSpan(p.windowS);
          view.resume();
        }}
      />
      <Button size="sm" variant={view.paused ? 'primary' : 'secondary'} icon={view.paused ? Play : Pause} onClick={() => (view.paused ? view.resume() : view.pause())}>
        {view.paused ? tScope('resume') : tScope('pause')}
      </Button>
      <span className="scope-toolbar__spacer" />
      <span className="scope-toolbar__hint">{tScope('cursorHint')}</span>
      {p.recommendedLabel && (
        <Button size="sm" variant="secondary" icon={Sparkles} onClick={p.onRecommended} title={tScope('recommendedHint', { name: p.recommendedLabel })}>
          {tScope('recommended')}
        </Button>
      )}
      <Button size="sm" variant="ghost" icon={Trash2} disabled={!p.hasSignals} onClick={p.onClear}>
        {tScope('clearAll')}
      </Button>
    </div>
  );
}
