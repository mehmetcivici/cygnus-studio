import { Eye, EyeOff, Plus, Trash2 } from 'lucide-react';
import { fmtValue, useI18n } from '../../i18n';
import { CHART_COLORS, IconButton, Panel, SegmentedControl, Select, Button, cx } from '../../ui';
import { useWindowStats } from './hooks';
import type { Axis } from './layout';
import { tScope } from './messages';
import type { PlotSignal } from './types';
import type { ScopeView } from './view';

export interface SignalsPanelProps {
  signals: readonly PlotSignal[];
  panes: readonly string[];
  view: ScopeView;
  /** Live layouts can add and remove signals; recordings cannot. */
  editable: boolean;
  onAdd: () => void;
  onRemove: (id: string) => void;
  onColor: (id: string, color: string) => void;
  onVisible: (id: string, visible: boolean) => void;
  onAxis: (id: string, axis: Axis) => void;
  onMove: (id: string, pane: string) => void;
}

function nextColor(current: string): string {
  const i = CHART_COLORS.findIndex((c) => c === current);
  return CHART_COLORS[(i + 1) % CHART_COLORS.length] ?? 'chart-1';
}

export function SignalsPanel({ signals, panes, view, editable, onAdd, onRemove, onColor, onVisible, onAxis, onMove }: SignalsPanelProps) {
  const { lang } = useI18n();
  const stats = useWindowStats(signals, view);
  const f = (v: number | undefined, s: PlotSignal): string => fmtValue(v ?? NaN, '', s.digits, { lang });
  return (
    <Panel
      title={tScope('signals')}
      subtitle={signals.length ? String(signals.length) : undefined}
      padding="none"
      actions={
        editable && (
          <Button size="sm" variant="secondary" icon={Plus} onClick={onAdd}>
            {tScope('addSignals')}
          </Button>
        )
      }
    >
      {signals.length === 0 ? (
        <p className="scope-side__hint">{tScope('signalsEmpty')}</p>
      ) : (
        <ul className="scope-sigs">
          {signals.map((s) => {
            const st = stats.get(s.id);
            return (
              <li key={s.id} className={cx('scope-sig', !s.visible && 'is-off', !s.present && 'is-missing')}>
                <div className="scope-sig__top">
                  <button
                    type="button"
                    className="scope-sig__swatch"
                    style={{ background: `var(--cy-${s.color})` }}
                    aria-label={tScope('cycleColor')}
                    title={tScope('cycleColor')}
                    onClick={() => onColor(s.id, nextColor(s.color))}
                  />
                  <div className="scope-sig__name" title={s.label}>
                    <span className="scope-sig__device">{s.device}</span>
                    <span className="scope-sig__signal">
                      {s.name}
                      {s.unit && <span className="scope-sig__unit"> · {s.unit}</span>}
                      {!s.present && <span className="scope-sig__missing"> · {tScope('missingDevice')}</span>}
                    </span>
                  </div>
                  <SegmentedControl<Axis>
                    size="sm"
                    value={s.axis}
                    onChange={(a) => onAxis(s.id, a)}
                    ariaLabel={tScope('axis')}
                    options={[
                      { value: 'left', label: tScope('axisLeftShort'), title: tScope('axisLeft') },
                      { value: 'right', label: tScope('axisRightShort'), title: tScope('axisRight') },
                    ]}
                  />
                  <IconButton size="sm" icon={s.visible ? Eye : EyeOff} label={s.visible ? tScope('hide') : tScope('show')} onClick={() => onVisible(s.id, !s.visible)} />
                  {editable && <IconButton size="sm" icon={Trash2} label={tScope('remove')} onClick={() => onRemove(s.id)} />}
                </div>
                <dl className="scope-sig__stats cy-mono">
                  <div>
                    <dt>{tScope('statLast')}</dt>
                    <dd>{f(s.buffer?.lastValue, s)}</dd>
                  </div>
                  <div>
                    <dt>{tScope('statMin')}</dt>
                    <dd>{f(st?.min, s)}</dd>
                  </div>
                  <div>
                    <dt>{tScope('statMax')}</dt>
                    <dd>{f(st?.max, s)}</dd>
                  </div>
                  <div>
                    <dt>{tScope('statMean')}</dt>
                    <dd>{f(st?.mean, s)}</dd>
                  </div>
                </dl>
                {panes.length > 1 && (
                  <div className="scope-sig__pane">
                    <span>{tScope('movePane')}</span>
                    <Select<string>
                      size="sm"
                      value={s.pane}
                      onChange={(p) => onMove(s.id, p)}
                      ariaLabel={tScope('movePane')}
                      options={panes.map((p, i) => ({ value: p, label: tScope('paneN', { n: i + 1 }) }))}
                    />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}
