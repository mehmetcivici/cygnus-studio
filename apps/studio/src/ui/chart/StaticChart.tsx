import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import './chart.css';
import { Maximize2 } from 'lucide-react';
import { currentLang, fmtNumber, fmtValue, t as translate, useI18n } from '../../i18n';
import { resolveColor, useTheme } from '../theme/theme';
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

/** Vertical marker line (cursor A/B, event) at an x value. */
export interface ChartMarker {
  x: number;
  /** Short tag drawn at the top ("A", "B", "−3 dB"). */
  label?: string;
  /** Token name (`accent`, `warn`, `chart-3` …) or CSS color; default the axis color. */
  color?: string;
  dashed?: boolean;
}

/** Horizontal reference line at a y value (0 dB, −180°, a limit). */
export interface ChartGuide {
  y: number;
  /** Which y axis the value belongs to (default `left`). */
  axis?: 'left' | 'right';
  /** Token name or CSS color; default the axis color. */
  color?: string;
  dashed?: boolean;
  /** Short tag drawn at the right end. */
  label?: string;
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
  /** `log`: logarithmic x axis (Bode, spectra); zoom/pan work in decades. x must be > 0. */
  xScale?: 'linear' | 'log';
  /** Vertical cursor/marker lines. Pass a stable array (memoised). */
  markers?: readonly ChartMarker[];
  /** Horizontal reference lines. Pass a stable array (memoised). */
  guides?: readonly ChartGuide[];
  /**
   * Click (without dragging) on the plot: x value under the pointer. Use it to place cursors:
   * `onPick={(x, e) => (e.shiftKey ? setB(x) : setA(x))}`.
   */
  onPick?: (x: number, e: MouseEvent) => void;
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

function extent(series: readonly StaticSeries[], log = false): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const s of series) {
    const n = s.x.length;
    for (let i = 0; i < n; i++) {
      const x = s.x[i] ?? NaN;
      if (log && !(x > 0)) continue;
      lo = Math.min(lo, x);
      break;
    }
    if (n) hi = Math.max(hi, s.x[n - 1] ?? hi);
  }
  if (Number.isFinite(lo) && hi > lo) return [lo, hi];
  return log ? [1, 10] : [0, 1];
}

/** Zoom/pan coordinates: linear, or log10 for a log axis (so a wheel step is the same in every decade). */
const fwd = (log: boolean, v: number): number => (log ? Math.log10(v) : v);
const inv = (log: boolean, v: number): number => (log ? 10 ** v : v);

function drawGuides(u: uPlot, guides: readonly ChartGuide[] | undefined): void {
  if (!guides?.length) return;
  const ctx = u.ctx;
  const dpr = uPlot.pxRatio;
  const { left, top, width, height } = u.bbox;
  ctx.save();
  ctx.lineWidth = 1.25 * dpr;
  ctx.font = `700 ${10.5 * dpr}px Lato, sans-serif`;
  ctx.textBaseline = 'bottom';
  ctx.textAlign = 'right';
  for (const g of guides) {
    const scale = g.axis === 'right' ? 'y2' : 'y';
    if (!u.scales[scale]) continue;
    const y = u.valToPos(g.y, scale, true);
    if (!Number.isFinite(y) || y < top || y > top + height) continue;
    const color = resolveColor(g.color ?? 'chart-axis');
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.setLineDash(g.dashed ? [4 * dpr, 3 * dpr] : []);
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(left + width, y);
    ctx.stroke();
    if (g.label) ctx.fillText(g.label, left + width - 4 * dpr, y - 2 * dpr);
  }
  ctx.restore();
}

function drawMarkers(u: uPlot, markers: readonly ChartMarker[] | undefined): void {
  if (!markers?.length) return;
  const ctx = u.ctx;
  const dpr = uPlot.pxRatio;
  const { left, top, width, height } = u.bbox;
  ctx.save();
  ctx.lineWidth = 1.5 * dpr;
  ctx.font = `700 ${10.5 * dpr}px Lato, sans-serif`;
  ctx.textBaseline = 'top';
  for (const m of markers) {
    const x = u.valToPos(m.x, 'x', true);
    if (!Number.isFinite(x) || x < left || x > left + width) continue;
    const color = resolveColor(m.color ?? 'chart-axis');
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.setLineDash(m.dashed ? [4 * dpr, 3 * dpr] : []);
    ctx.beginPath();
    ctx.moveTo(x, top);
    ctx.lineTo(x, top + height);
    ctx.stroke();
    if (m.label) {
      ctx.textAlign = x > left + width - 40 * dpr ? 'right' : 'left';
      ctx.fillText(m.label, x + (ctx.textAlign === 'right' ? -4 : 4) * dpr, top + 2 * dpr);
    }
  }
  ctx.restore();
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
  xScale = 'linear',
  markers,
  guides,
  onPick,
  className,
}: StaticChartProps) {
  const log = xScale === 'log';
  const xUnitRef = useRef(xUnit);
  xUnitRef.current = xUnit;
  const markersRef = useRef(markers);
  markersRef.current = markers;
  const guidesRef = useRef(guides);
  guidesRef.current = guides;
  const pickRef = useRef(onPick);
  pickRef.current = onPick;
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
  const full = useMemo(() => extent(series, log), [series, log]);
  const view = useRef<[number, number]>(full);
  const valueEls = useRef<(HTMLSpanElement | null)[]>([]);
  const headerEl = useRef<HTMLSpanElement | null>(null);

  const writeLegend = useCallback((at: number | null) => {
    const l = currentLang();
    if (headerEl.current) {
      headerEl.current.textContent =
        at === null ? translate('ui.chart.cursor') : `${translate('ui.chart.cursor')} · ${fmtNumber(at, 3, { lang: l, grouping: false })} ${xUnitRef.current}`;
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
    view.current = extent(seriesRef.current, log);
    u?.setScale('x', { min: view.current[0], max: view.current[1] });
  }, [log]);

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
      xLog: log,
      onCursor: (u) => {
        const left = u.cursor.left ?? -1;
        writeLegend(left >= 0 ? u.posToVal(left, 'x') : null);
      },
      onDraw: (u) => {
        drawGuides(u, guidesRef.current);
        drawMarkers(u, markersRef.current);
      },
    });
    const u = new uPlot(opts, alignData(ss), el);
    uRef.current = u;
    writeLegend(null);
    const apply = (): void => u.setScale('x', { min: view.current[0], max: view.current[1] });
    const detach = attachInteractions(u, {
      zoom: (factor, at) => {
        const a = fwd(log, view.current[0]);
        const b = fwd(log, view.current[1]);
        const c = Number.isFinite(at) && (!log || at > 0) ? fwd(log, at) : (a + b) / 2;
        view.current = [inv(log, c - (c - a) * factor), inv(log, c + (b - c) * factor)];
        apply();
      },
      pan: (dt) => {
        if (log) {
          // dt arrives in data units across the visible span; convert to a decade shift.
          const width = u.over.clientWidth || 1;
          const span = (u.scales.x?.max ?? 1) - (u.scales.x?.min ?? 0);
          const px = (dt / (span || 1)) * width;
          const a = fwd(true, view.current[0]);
          const b = fwd(true, view.current[1]);
          const d = (px / width) * (b - a);
          view.current = [inv(true, a + d), inv(true, b + d)];
        } else {
          const [a, b] = view.current;
          view.current = [a + dt, b + dt];
        }
        apply();
        return true;
      },
      reset: resetView,
    });
    // A click that did not drag picks an x (cursor placement).
    let downX: number | null = null;
    const onDown = (e: MouseEvent): void => {
      downX = e.clientX;
    };
    const onClick = (e: MouseEvent): void => {
      if (downX === null || Math.abs(e.clientX - downX) > 3 || !pickRef.current) return;
      const rect = u.over.getBoundingClientRect();
      pickRef.current(u.posToVal(e.clientX - rect.left, 'x'), e);
    };
    u.over.addEventListener('mousedown', onDown);
    u.over.addEventListener('click', onClick);
    const unobserve = observeSize(el, (w, h) => u.setSize({ width: w, height: h }));
    return () => {
      unobserve();
      detach();
      u.over.removeEventListener('mousedown', onDown);
      u.over.removeEventListener('click', onClick);
      u.destroy();
      uRef.current = null;
    };
  }, [series, scaleSig, theme, lang, xUnit, log, writeLegend, resetView]);

  // Markers change without rebuilding the plot.
  useEffect(() => {
    uRef.current?.redraw(false, false);
  }, [markers, guides]);

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
