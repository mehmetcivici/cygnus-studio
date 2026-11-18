import type { BusStats } from '@cygnus/protocol';
import { fmtNumber, useI18n } from '../../i18n';
import { Badge } from '../../ui';
import type { TraceSnapshot } from './engine';
import { CLASS_NAMES, idHex } from './ids';
import { tCanMonitor } from './messages';
import { classTone } from './parts';
import { cx } from '../../ui';

function bucketLabel(b: number): string {
  if (b === -1) return tCanMonitor('kind.legacy');
  if (b === -2) return tCanMonitor('kind.foreign');
  return CLASS_NAMES[b] ?? `0x${b.toString(16).toUpperCase()}`;
}

/** Representative id for colouring a class bucket. */
function bucketTone(b: number): 'neutral' | ReturnType<typeof classTone> {
  return b < 0 ? 'neutral' : classTone(b << 10 | 8 << 16);
}

export function StatsStrip({ snap, stats, online }: { snap: TraceSnapshot; stats: BusStats | null; online: boolean }) {
  const { lang } = useI18n();
  const n = (v: number, d = 0): string => fmtNumber(v, d, { lang });
  const total = snap.rates.totalFps;
  const classes = [...snap.rates.classFps].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, 6);
  const load = stats?.loadPct ?? 0;
  const loadTone = load > 80 ? 'danger' : load > 60 ? 'caution' : 'ok';
  return (
    <div className="canmon-stats" aria-label={tCanMonitor('stats.title')}>
      <div className="canmon-stats__kpis">
        <div className="canmon-kpi">
          <span className="canmon-kpi__label">{tCanMonitor('stats.load')}</span>
          <strong className={cx('cy-mono', `is-${loadTone}`)}>{online && stats ? `${n(load, 1)} %` : '—'}</strong>
          <span className="canmon-kpi__bar">
            <span className={`is-${loadTone}`} style={{ width: `${Math.min(100, load)}%` }} />
          </span>
        </div>
        <div className="canmon-kpi">
          <span className="canmon-kpi__label">RX</span>
          <strong className="cy-mono">{online && stats ? `${n(stats.rxFps)} /s` : '—'}</strong>
        </div>
        <div className="canmon-kpi">
          <span className="canmon-kpi__label">TX</span>
          <strong className="cy-mono">{online && stats ? `${n(stats.txFps)} /s` : '—'}</strong>
        </div>
      </div>

      <div className="canmon-stats__classes" role="img" aria-label={tCanMonitor('stats.byClass')}>
        <span className="canmon-stats__title">{tCanMonitor('stats.byClass')}</span>
        {classes.length === 0 ? (
          <span className="canmon-stats__none">—</span>
        ) : (
          <ul>
            {classes.map(([b, v]) => (
              <li key={b} title={`${bucketLabel(b)} · ${n(v)} /s`}>
                <span className="canmon-bar">
                  <span className={`canmon-bar__fill canmon-bar__fill--${bucketTone(b)}`} style={{ height: `${Math.max(6, (v / (classes[0]?.[1] ?? 1)) * 100)}%` }} />
                </span>
                <span className="canmon-bar__label cy-mono">{bucketLabel(b)}</span>
                <span className="canmon-bar__pct cy-mono">{total > 0 ? `${n((v / total) * 100)}%` : ''}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="canmon-stats__talkers">
        <span className="canmon-stats__title">{tCanMonitor('stats.talkers')}</span>
        {snap.rates.top.length === 0 ? (
          <span className="canmon-stats__none">—</span>
        ) : (
          <ul>
            {snap.rates.top.map((e) => (
              <li key={e.id}>
                <Badge size="sm" tone={classTone(e.id)} mono>
                  {idHex(e.id)}
                </Badge>
                <span className="cy-mono">{n(e.fps)} /s</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
