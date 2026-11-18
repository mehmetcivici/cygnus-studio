import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import './chart.css';
import { Maximize2 } from 'lucide-react';
import { currentLang, fmtNumber, fmtValue, t as translate, useI18n } from '../../i18n';
import { useTheme } from '../theme/theme';
import { IconButton } from '../components/IconButton';
import { ChartLegend } from './ChartLegend';
import {
  AUTO_SCALE,
  attachInteractions,
  buildOptions,
  nearestSorted,
  observeSize,
  resolvedSeriesColor,
  type ChartScale,
  type ChartSeriesStyle,
} from './chartShared';

/** A recorded signal with its own (ascending) time axis. */
export interface StaticSeries extends ChartSeriesStyle {
  x: ArrayLike<number>;
  y: ArrayLike<number>;
}

export interface StaticChartProps {
  /**
   * Series may have different x arrays (e.g. overlaid tuner runs, each starting
   * at t = 0); they are aligned with `uPlot.join`. Series sharing the same x
   * array instance skip the join.
   */
  series: readonly StaticSeries[];
  yLeft?: ChartScale;
  yRight?: ChartScale;
  legend?: 'right' | 'bottom' | 'none';
  toolbar?: boolean;
  title?: ReactNode;
  actions?: ReactNode;
  height?: number;
  xUnit?: string;
  className?: string;
}

type Column = number[] | Float64Array;

function toColumn(a: ArrayLike<number>): Column {
  return Array.isArray(a) || a instanceof Float64Array ? (a as Column) : Float64Array.from(a);
}

function alignData(series: readonly StaticSeries[]): uPlot.AlignedData {
  if (!series.length) return [new Float64Array(0)];
  const first = series[0];
  if (first && series.every((s) => s.x === first.x)) return [toColumn(first.x), ...series.map((s) => toColumn(s.y))];
  return uPlot.join(series.map((s) => [toColumn(s.x), toColumn(s.y)]));
}

function extent(series: readonly StaticSeries[]): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const s of series) {
    const n = s.x.length;
    if (!n) continue;
    lo = Math.min(lo, s.x[0] ?? lo);
    hi = Math.max(hi, s.x[n - 1] ?? hi);
  }
  return Number.isFinite(lo) && hi > lo ? [lo, hi] : [0, 1];
}

/**
 * Chart for recorded data (log viewer, run comparison). Wheel zooms, drag
 * pans, double-click shows everything; hover reads each series at its own
 * nearest sample.
 */
export function StaticChart({
  series,
  yLeft = AUTO_SCALE,
  yRight = AUTO_SCALE,
  legend = 'right',
  toolbar = true,
  title,
  actions,
  height,
  xUnit = 's',
  className,
}: StaticChartProps) {
  const { t, lang } = useI18n();
  const theme = useTheme((s) => s.theme);
  const plotRef = useRef<HTMLDivElement>(null);
  const uRef = useRef<uPlot | null>(null);
  const seriesRef = useRef(series);
  seriesRef.current = series;
  const [hidden, setHidden] = useState<ReadonlySet<string>>(
    () => new Set(series.filter((s) => s.visible === false).map((s) => s.key)),
  );
  const hiddenRef = useRef(hidden);
  hiddenRef.current = hidden;
  const full = useMemo(() => extent(series), [series]);
  const view = useRef<[number, number]>(full);
  const valueEls = useRef<(HTMLSpanElement | null)[]>([]);
  const headerEl = useRef<HTMLSpanElement | null>(null);

  const writeLegend = useCallback((at: number | null) => {
    const l = currentLang();
    if (headerEl.current) {
      headerEl.current.textContent =
        at === null ? translate('ui.chart.cursor') : `${translate('ui.chart.cursor')} · ${fmtNumber(at, 3, { lang: l, grouping: false })} s`;
    }
    seriesRef.current.forEach((s, i) => {
      const el = valueEls.current[i];
      if (!el) return;
      const idx = at === null ? -1 : nearestSorted(s.x, at);
      el.textContent = fmtValue(idx < 0 ? null : (s.y[idx] ?? null), s.unit, s.digits ?? 2, { lang: l });
    });
  }, []);

  const colors = useMemo(() => series.map((s, i) => resolvedSeriesColor(s, i)), [series, theme]);
  const scaleSig = JSON.stringify([yLeft, yRight]);

  const resetView = useCallback(() => {
    const u = uRef.current;
    view.current = extent(seriesRef.current);
    u?.setScale('x', { min: view.current[0], max: view.current[1] });
  }, []);

  useEffect(() => {
    view.current = full;
  }, [full]);

  useEffect(() => {
    const el = plotRef.current;
    if (!el) return;
    const ss = seriesRef.current;
    const opts = buildOptions({
      width: Math.max(1, el.clientWidth),
      height: Math.max(1, el.clientHeight),
      series: ss.map((s) => ({ ...s, visible: !hiddenRef.current.has(s.key) })),
      xRange: () => view.current,
      yLeft,
      yRight,
      xUnit,
      onCursor: (u) => {
        const left = u.cursor.left ?? -1;
        writeLegend(left >= 0 ? u.posToVal(left, 'x') : null);
      },
    });
    const u = new uPlot(opts, alignData(ss), el);
    uRef.current = u;
    writeLegend(null);
    const apply = (): void => u.setScale('x', { min: view.current[0], max: view.current[1] });
    const detach = attachInteractions(u, {
      zoom: (factor, at) => {
        const [a, b] = view.current;
        const c = Number.isFinite(at) ? at : (a + b) / 2;
        view.current = [c - (c - a) * factor, c + (b - c) * factor];
        apply();
      },
      pan: (dt) => {
        const [a, b] = view.current;
        view.current = [a + dt, b + dt];
        apply();
        return true;
      },
      reset: resetView,
    });
    const unobserve = observeSize(el, (w, h) => u.setSize({ width: w, height: h }));
    return () => {
      unobserve();
      detach();
      u.destroy();
      uRef.current = null;
    };
  }, [series, scaleSig, theme, lang, xUnit, writeLegend, resetView]);

  const toggle = useCallback((key: string) => {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      const idx = seriesRef.current.findIndex((s) => s.key === key);
      uRef.current?.setSeries(idx + 1, { show: !next.has(key) });
      return next;
    });
  }, []);

  const legendStyles = useMemo(() => series.map(({ x: _x, y: _y, ...style }) => style), [series]);

  return (
    <div
      className={`cy-chart cy-chart--static cy-chart--legend-${legend}${className ? ` ${className}` : ''}`}
      style={height ? { height } : undefined}
    >
      {toolbar && (
        <div className="cy-chart__toolbar">
          {title && <span className="cy-chart__title">{title}</span>}
          <span className="cy-chart__spacer" />
          {actions}
          <IconButton size="sm" icon={Maximize2} label={t('ui.chart.resetView')} onClick={resetView} />
        </div>
      )}
      <div className="cy-chart__body">
        <div className="cy-chart__plot" ref={plotRef} />
        {legend !== 'none' && (
          <ChartLegend
            series={legendStyles}
            colors={colors}
            hidden={hidden}
            onToggle={toggle}
            placement={legend}
            valueRef={(i, el) => {
              valueEls.current[i] = el;
            }}
            headerRef={(el) => {
              headerEl.current = el;
            }}
          />
        )}
      </div>
    </div>
  );
}
