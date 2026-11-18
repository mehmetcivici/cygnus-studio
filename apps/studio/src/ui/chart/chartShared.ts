import uPlot from 'uplot';
import { currentLang, fmtNumber } from '../../i18n';
import { chartColor, resolveColor } from '../theme/theme';

/** Visual description of one plotted signal (shared by LiveChart and StaticChart). */
export interface ChartSeriesStyle {
  /** Stable identity (used for visibility state and React keys). */
  key: string;
  /** Legend label, already translated. */
  label: string;
  /** CSS color or theme token (`chart-3`, `accent`, `var(--cy-ok)`). Defaults to the palette by index. */
  color?: string;
  /** Unit shown in legend and on the axis label. */
  unit?: string;
  /** Which y axis the series uses (default `left`). */
  axis?: 'left' | 'right';
  /** Decimals in the legend readout (default 2). */
  digits?: number;
  /** Line width in CSS px (default 1.5). */
  width?: number;
  /** Canvas dash pattern, e.g. `[6, 4]` for setpoints. */
  dash?: number[];
  /** Initial visibility (default true). The legend toggles it afterwards. */
  visible?: boolean;
}

/** Y-scale: automatic (padded, snapped to nice values) or fixed limits. */
export type ChartScale = { mode: 'auto' } | { mode: 'fixed'; min: number; max: number };

export const AUTO_SCALE: ChartScale = { mode: 'auto' };

export interface BuildOptions {
  width: number;
  height: number;
  series: readonly ChartSeriesStyle[];
  xRange: (u: uPlot, min: number, max: number) => uPlot.Range.MinMax;
  yLeft: ChartScale;
  yRight: ChartScale;
  xUnit: string;
  onCursor: (u: uPlot) => void;
}

function tickDigits(incr: number): number {
  if (!Number.isFinite(incr) || incr <= 0) return 0;
  return Math.max(0, Math.min(6, Math.ceil(-Math.log10(incr) - 1e-9)));
}

function yRange(scale: ChartScale): uPlot.Range.Function {
  return (_u, min, max) => {
    if (scale.mode === 'fixed') return [scale.min, scale.max];
    if (min == null || max == null || !Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
    if (min === max) {
      const pad = Math.abs(min) * 0.1 || 1;
      return [min - pad, max + pad];
    }
    const r = uPlot.rangeNum(min, max, 0.08, true);
    return [r[0] ?? min, r[1] ?? max];
  };
}

function unitsLabel(series: readonly ChartSeriesStyle[], axis: 'left' | 'right'): string {
  const units = new Set<string>();
  for (const s of series) if ((s.axis ?? 'left') === axis && s.unit) units.add(s.unit);
  return [...units].join(' · ');
}

export function resolvedSeriesColor(s: ChartSeriesStyle, index: number): string {
  return resolveColor(s.color ?? chartColor(index));
}

/** Builds uPlot options that follow the current theme tokens. */
export function buildOptions(o: BuildOptions): uPlot.Options {
  const axisColor = resolveColor('chart-axis');
  const gridColor = resolveColor('chart-grid');
  const font = `500 10.5px ${getComputedStyle(document.documentElement).getPropertyValue('--cy-font-mono') || 'monospace'}`;
  const labelFont = `700 10.5px Lato, sans-serif`;
  const hasRight = o.series.some((s) => s.axis === 'right');

  const fmtTicks =
    (suffix: string) =>
    (_u: uPlot, splits: number[], _axisIdx: number, _space: number, incr: number): string[] => {
      const d = tickDigits(incr);
      const lang = currentLang();
      return splits.map((v) => `${fmtNumber(v, d, { lang, grouping: false })}${suffix}`);
    };

  const baseAxis: uPlot.Axis = {
    stroke: axisColor,
    font,
    labelFont,
    grid: { stroke: gridColor, width: 1 },
    ticks: { stroke: gridColor, width: 1, size: 4 },
    border: { show: false },
    gap: 4,
  };

  const axes: uPlot.Axis[] = [
    { ...baseAxis, scale: 'x', values: fmtTicks(o.xUnit ? ` ${o.xUnit}` : ''), size: 28, space: 70 },
    {
      ...baseAxis,
      scale: 'y',
      side: 3,
      values: fmtTicks(''),
      size: 52,
      space: 32,
      label: unitsLabel(o.series, 'left'),
      labelSize: 14,
      labelGap: 2,
    },
  ];
  if (hasRight) {
    axes.push({
      ...baseAxis,
      scale: 'y2',
      side: 1,
      values: fmtTicks(''),
      size: 52,
      space: 32,
      grid: { show: false },
      label: unitsLabel(o.series, 'right'),
      labelSize: 14,
      labelGap: 2,
    });
  }

  const scales: uPlot.Scales = {
    x: { time: false, range: o.xRange },
    y: { auto: true, range: yRange(o.yLeft) },
  };
  if (hasRight) scales.y2 = { auto: true, range: yRange(o.yRight) };

  return {
    width: o.width,
    height: o.height,
    pxAlign: 0,
    padding: [10, hasRight ? 4 : 14, 0, 4],
    legend: { show: false },
    // Hovering near a trace highlights it; others stay readable.
    focus: { alpha: 0.35 },
    scales,
    axes,
    cursor: {
      drag: { x: false, y: false, setScale: false },
      points: { show: false },
      y: false,
      focus: { prox: 16 },
    },
    series: [
      {},
      ...o.series.map((s, i): uPlot.Series => ({
        label: s.label,
        scale: s.axis === 'right' ? 'y2' : 'y',
        stroke: resolvedSeriesColor(s, i),
        width: s.width ?? 1.5,
        dash: s.dash,
        spanGaps: true,
        points: { show: false },
        show: s.visible !== false,
      })),
    ],
    hooks: { setCursor: [o.onCursor] },
  };
}

export interface ViewHandlers {
  /** Zoom by factor around time `t` (factor < 1 zooms in). */
  zoom: (factor: number, t: number) => void;
  /** Pan by a time delta; return false to refuse (live mode). */
  pan: (dt: number) => boolean;
  reset: () => void;
}

/** Wheel zoom, drag pan and double-click reset on the plot overlay. Returns a cleanup fn. */
export function attachInteractions(u: uPlot, h: ViewHandlers): () => void {
  const over = u.over;
  const onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const rect = over.getBoundingClientRect();
    const t = u.posToVal(e.clientX - rect.left, 'x');
    h.zoom(Math.exp(Math.max(-1, Math.min(1, e.deltaY / 300))), t);
  };
  let dragX: number | null = null;
  const onDown = (e: MouseEvent): void => {
    if (e.button !== 0) return;
    dragX = e.clientX;
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };
  const onMove = (e: MouseEvent): void => {
    if (dragX === null) return;
    const width = over.clientWidth || 1;
    const min = u.scales.x?.min ?? 0;
    const max = u.scales.x?.max ?? 1;
    const dt = ((dragX - e.clientX) / width) * (max - min);
    if (h.pan(dt)) {
      dragX = e.clientX;
      over.style.cursor = 'grabbing';
    }
  };
  const onUp = (): void => {
    dragX = null;
    over.style.cursor = '';
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
  };
  const onDbl = (): void => h.reset();
  over.addEventListener('wheel', onWheel, { passive: false });
  over.addEventListener('mousedown', onDown);
  over.addEventListener('dblclick', onDbl);
  return () => {
    onUp();
    over.removeEventListener('wheel', onWheel);
    over.removeEventListener('mousedown', onDown);
    over.removeEventListener('dblclick', onDbl);
  };
}

/** Binary search for the index nearest to `t` in an ascending array. */
export function nearestSorted(xs: ArrayLike<number>, t: number): number {
  const n = xs.length;
  if (!n) return -1;
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((xs[mid] ?? 0) < t) lo = mid + 1;
    else hi = mid;
  }
  if (lo >= n) return n - 1;
  if (lo === 0) return 0;
  return t - (xs[lo - 1] ?? 0) <= (xs[lo] ?? 0) - t ? lo - 1 : lo;
}

/** Observes element size and reports integer CSS pixels. */
export function observeSize(el: HTMLElement, cb: (w: number, h: number) => void): () => void {
  const ro = new ResizeObserver((entries) => {
    const r = entries[0]?.contentRect;
    if (r) cb(Math.max(1, Math.floor(r.width)), Math.max(1, Math.floor(r.height)));
  });
  ro.observe(el);
  return () => ro.disconnect();
}
