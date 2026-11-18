import { useDeferredValue, useEffect, useMemo, useState } from 'react';
import { X } from 'lucide-react';
import { fmtNumber, fmtValue, useI18n } from '../../i18n';
import { Button } from '../../ui';
import { useViewRev } from './hooks';
import { cursorDelta, measureSignal } from './measure';
import { tScope } from './messages';
import type { PlotSignal } from './types';
import type { ScopeView } from './view';

function fmtTime(dt: number, lang: 'tr' | 'en'): string {
  const a = Math.abs(dt);
  if (a < 1e-3) return `${fmtNumber(dt * 1e6, 1, { lang })} µs`;
  if (a < 1) return `${fmtNumber(dt * 1e3, a < 0.01 ? 3 : 2, { lang })} ms`;
  return `${fmtNumber(dt, 3, { lang })} s`;
}

function fmtFreq(hz: number | null, lang: 'tr' | 'en'): string {
  if (hz === null) return '—';
  if (hz >= 1000) return `${fmtNumber(hz / 1000, 2, { lang })} kHz`;
  return `${fmtNumber(hz, hz < 10 ? 2 : 1, { lang })} Hz`;
}

/** Two-cursor readout: Δt, 1/Δt, and per-signal values and statistics between the cursors. */
export function MeasurePanel({ view, signals }: { view: ScopeView; signals: readonly PlotSignal[] }) {
  const { lang } = useI18n();
  const rev = useDeferredValue(useViewRev(view));
  // Live data keeps landing between the cursors when B is near "now".
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const h = setInterval(() => setTick((n) => n + 1), 500);
    return () => clearInterval(h);
  }, []);
  const [a, b] = view.cursors;
  const rows = useMemo(() => {
    if (a === null) return [];
    return signals
      .filter((s) => s.visible && s.buffer)
      .map((s) => ({ s, m: s.buffer ? measureSignal(s.buffer, a, b ?? a) : null }));
    // `rev` and `tick` are the invalidation signals; cursor times are read from the view.
  }, [signals, a, b, rev, tick]);
  if (a === null && b === null) return null;
  const both = a !== null && b !== null;
  const d = both ? cursorDelta(a, b) : null;
  const v = (x: number | undefined, s: PlotSignal): string => fmtValue(x ?? NaN, s.unit, s.digits, { lang });
  return (
    <section className="scope-measure" aria-label={tScope('measure')}>
      <header className="scope-measure__head">
        <span className="scope-measure__title">{tScope('measure')}</span>
        {a !== null && (
          <span className="scope-measure__kv">
            <b className="scope-measure__tag">A</b>
            <span className="cy-mono">{fmtNumber(a, 4, { lang, grouping: false })} s</span>
          </span>
        )}
        {b !== null && (
          <span className="scope-measure__kv">
            <b className="scope-measure__tag">B</b>
            <span className="cy-mono">{fmtNumber(b, 4, { lang, grouping: false })} s</span>
          </span>
        )}
        {d ? (
          <>
            <span className="scope-measure__kv">
              <span>Δt</span>
              <strong className="cy-mono">{fmtTime(d.dt, lang)}</strong>
            </span>
            <span className="scope-measure__kv">
              <span>1/Δt</span>
              <strong className="cy-mono">{fmtFreq(d.freq, lang)}</strong>
            </span>
          </>
        ) : (
          <span className="scope-measure__hint">{tScope('placeB')}</span>
        )}
        <span className="scope-measure__spacer" />
        <Button size="sm" variant="ghost" icon={X} onClick={() => view.clearCursors()}>
          {tScope('clearCursors')}
        </Button>
      </header>
      <div className="scope-measure__scroll">
        <table className="scope-measure__table">
          <thead>
            <tr>
              <th>{tScope('signal')}</th>
              <th>A</th>
              {both && (
                <>
                  <th>B</th>
                  <th>Δy</th>
                  <th>{tScope('statMin')}</th>
                  <th>{tScope('statMax')}</th>
                  <th>{tScope('statMean')}</th>
                  <th>RMS</th>
                </>
              )}
            </tr>
          </thead>
          <tbody>
            {rows.map(({ s, m }) => (
              <tr key={s.id}>
                <td>
                  <span className="scope-chip__dot" style={{ background: `var(--cy-${s.color})` }} />
                  {s.label}
                </td>
                <td className="cy-mono">{v(m?.atA, s)}</td>
                {both && (
                  <>
                    <td className="cy-mono">{v(m?.atB, s)}</td>
                    <td className="cy-mono">{v(m?.dy, s)}</td>
                    <td className="cy-mono">{v(m?.between?.min, s)}</td>
                    <td className="cy-mono">{v(m?.between?.max, s)}</td>
                    <td className="cy-mono">{v(m?.between?.mean, s)}</td>
                    <td className="cy-mono">{v(m?.between?.rms, s)}</td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
