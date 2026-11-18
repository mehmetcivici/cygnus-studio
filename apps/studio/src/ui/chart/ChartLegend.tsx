import type { ChartSeriesStyle } from './chartShared';
import { useI18n } from '../../i18n';

export interface ChartLegendProps {
  series: readonly ChartSeriesStyle[];
  colors: readonly string[];
  hidden: ReadonlySet<string>;
  onToggle: (key: string) => void;
  placement: 'right' | 'bottom';
  /** Value cells are written imperatively by the chart (no React re-render per frame). */
  valueRef: (index: number, el: HTMLSpanElement | null) => void;
  headerRef: (el: HTMLSpanElement | null) => void;
}

export function ChartLegend({ series, colors, hidden, onToggle, placement, valueRef, headerRef }: ChartLegendProps) {
  const { t } = useI18n();
  return (
    <div className={`cy-chart__legend cy-chart__legend--${placement}`}>
      <div className="cy-chart__legend-head">
        <span ref={headerRef} className="cy-chart__legend-time">
          {t('ui.chart.latest')}
        </span>
      </div>
      <ul className="cy-chart__legend-list">
        {series.map((s, i) => {
          const off = hidden.has(s.key);
          return (
            <li key={s.key}>
              <button
                type="button"
                className={`cy-chart__legend-item${off ? ' is-off' : ''}`}
                onClick={() => onToggle(s.key)}
                aria-pressed={!off}
                title={t('ui.chart.toggleSeries')}
              >
                <span
                  className={`cy-chart__swatch${s.dash ? ' is-dashed' : ''}`}
                  style={{ ['--swatch' as string]: colors[i] ?? 'currentColor' }}
                  aria-hidden
                />
                <span className="cy-chart__legend-label">
                  {s.label}
                  {s.axis === 'right' && <span className="cy-chart__axis-tag">R</span>}
                </span>
                <span className="cy-chart__legend-value" ref={(el) => valueRef(i, el)}>
                  —
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
