import { memo, useMemo } from 'react';
import { Plus, X } from 'lucide-react';
import { Button, IconButton, cx } from '../../ui';
import { MAX_PANES } from './layout';
import { ScopeChart, type ChartSeries } from './ScopeChart';
import { tScope } from './messages';
import type { PlotSignal } from './types';
import type { ScopeView } from './view';

interface PaneProps {
  index: number;
  id: string;
  signals: readonly PlotSignal[];
  view: ScopeView;
  canRemove: boolean;
  onRemove: (id: string) => void;
  onToggle: (signalId: string) => void;
}

const Pane = memo(function Pane({ index, id, signals, view, canRemove, onRemove, onToggle }: PaneProps) {
  const series = useMemo<ChartSeries[]>(
    () =>
      signals.map((s) => ({ id: s.id, label: s.label, unit: s.unit, color: s.color, axis: s.axis, visible: s.visible, digits: s.digits, buffer: s.buffer })),
    [signals],
  );
  return (
    <section className="scope-pane" data-pane={id}>
      <header className="scope-pane__head">
        <span className="scope-pane__title">{tScope('paneN', { n: index + 1 })}</span>
        <div className="scope-pane__chips">
          {signals.map((s) => (
            <button
              key={s.id}
              type="button"
              className={cx('scope-chip', !s.visible && 'is-off', !s.present && 'is-missing')}
              aria-pressed={s.visible}
              title={s.label}
              onClick={() => onToggle(s.id)}
            >
              <span className="scope-chip__dot" style={{ background: `var(--cy-${s.color})` }} />
              <span className="scope-chip__text">{s.label}</span>
              {s.axis === 'right' && <span className="scope-chip__axis">{tScope('axisRightShort')}</span>}
            </button>
          ))}
        </div>
        {canRemove && <IconButton size="sm" icon={X} label={tScope('removePane')} onClick={() => onRemove(id)} />}
      </header>
      {signals.length === 0 ? <div className="scope-pane__empty">{tScope('paneEmpty')}</div> : <ScopeChart view={view} series={series} />}
    </section>
  );
});

export interface PanesProps {
  panes: readonly string[];
  signals: readonly PlotSignal[];
  view: ScopeView;
  editable: boolean;
  onAddPane: () => void;
  onRemovePane: (id: string) => void;
  onToggle: (signalId: string) => void;
}

export function Panes({ panes, signals, view, editable, onAddPane, onRemovePane, onToggle }: PanesProps) {
  const byPane = useMemo(() => {
    const m = new Map<string, PlotSignal[]>();
    for (const p of panes) m.set(p, []);
    for (const s of signals) m.get(s.pane)?.push(s);
    return m;
  }, [panes, signals]);
  return (
    <div className="scope-panes">
      {panes.map((p, i) => (
        <Pane key={p} index={i} id={p} signals={byPane.get(p) ?? []} view={view} canRemove={editable && panes.length > 1} onRemove={onRemovePane} onToggle={onToggle} />
      ))}
      {editable && panes.length < MAX_PANES && (
        <Button size="sm" variant="ghost" icon={Plus} className="scope-panes__add" onClick={onAddPane}>
          {tScope('addPane')}
        </Button>
      )}
    </div>
  );
}
