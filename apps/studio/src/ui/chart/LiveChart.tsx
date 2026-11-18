import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import './chart.css';
import { Maximize2, Pause, Play } from 'lucide-react';
import { fmtNumber, fmtValue, useI18n, t as translate, currentLang } from '../../i18n';
import { useTheme } from '../theme/theme';
import { IconButton } from '../components/IconButton';
import { SeriesBuffer, decimationGrid } from './SeriesBuffer';
import { ChartLegend } from './ChartLegend';
import {
  AUTO_SCALE,
  attachInteractions,
  buildOptions,
  observeSize,
  resolvedSeriesColor,
  type ChartScale,
  type ChartSeriesStyle,
} from './chartShared';

/** A live signal: style + the ring buffer the producer pushes into. */
export interface LiveSeries extends ChartSeriesStyle {
  buffer: SeriesBuffer;
}

export interface LiveChartProps {
  series: readonly LiveSeries[];
  /** Visible time span in seconds while following live data (default 10). */
  window?: number;
  /** Controlled pause state. Omit to let the chart manage it. */
  paused?: boolean;
  onPausedChange?: (paused: boolean) => void;
  /**
   * Clock in seconds defining the right edge while live. Defaults to the newest
   * sample across all buffers, which keeps the trace pinned to the edge.
   */
  now?: () => number;
  yLeft?: ChartScale;
  yRight?: ChartScale;
  /** Legend placement (default `right`). */
  legend?: 'right' | 'bottom' | 'none';
  /** Show the header with live badge and pause/reset buttons (default true). */
  toolbar?: boolean;
  title?: ReactNode;
  /** Extra controls rendered at the right of the header. */
  actions?: ReactNode;
  /** Fixed height in px; omit to fill the parent (parent needs a height). */
  height?: number;
  /** Unit appended to x tick labels (default `s`). */
  xUnit?: string;
  className?: string;
}

const MIN_SPAN = 0.002;
const MAX_SPAN = 3600;
const LEGEND_LATEST_MS = 120;

/**
 * High-rate streaming chart on uPlot.
 *
 * Data never enters React state: producers push into `SeriesBuffer`s and a
 * `requestAnimationFrame` loop min/max-decimates the visible window to ~2
 * points per pixel column, so 10+ series at 1 kHz stay at 60 fps.
 *
 * ```tsx
 * const vel = useMemo(() => new SeriesBuffer(60_000), []);
 * // elsewhere: vel.push(tSeconds, rpm)
 * <LiveChart window={10} series={[{ key: 'vel', label: 'Hız', unit: 'rpm', buffer: vel }]} />
 * ```
 * Interaction: wheel zooms time (around the cursor when paused), dragging pans
 * (and pauses), double-click restores the configured window, legend items
 * toggle series, hovering reads exact sample values.
 */
export function LiveChart({
  series,
  window: windowSpan = 10,
  paused: pausedProp,
  onPausedChange,
  now,
  yLeft = AUTO_SCALE,
  yRight = AUTO_SCALE,
  legend = 'right',
  toolbar = true,
  title,
  actions,
  height,
  xUnit = 's',
  className,
}: LiveChartProps) {
  const { t, lang } = useI18n();
  const theme = useTheme((s) => s.theme);
  const [pausedState, setPausedState] = useState(false);
  const paused = pausedProp ?? pausedState;
  const [hidden, setHidden] = useState<ReadonlySet<string>>(
    () => new Set(series.filter((s) => s.visible === false).map((s) => s.key)),
  );
  const [span, setSpan] = useState(windowSpan);

  const plotRef = useRef<HTMLDivElement>(null);
  const uRef = useRef<uPlot | null>(null);
  const seriesRef = useRef(series);
  seriesRef.current = series;
  const nowRef = useRef(now);
  nowRef.current = now;
  const hiddenRef = useRef(hidden);
  hiddenRef.current = hidden;
  const pausedRef = useRef(paused);
  const view = useRef({ span: windowSpan, end: Number.NaN, t0: -windowSpan, t1: 0, dirty: true });
  const cursorT = useRef<number | null>(null);
  const valueEls = useRef<(HTMLSpanElement | null)[]>([]);
  const headerEl = useRef<HTMLSpanElement | null>(null);

  const setPaused = useCallback(
    (p: boolean) => {
      if (pausedProp === undefined) setPausedState(p);
      onPausedChange?.(p);
    },
    [pausedProp, onPausedChange],
  );
  const setPausedRef = useRef(setPaused);
  setPausedRef.current = setPaused;

  const liveNow = useCallback((): number => {
    const clock = nowRef.current;
    if (clock) return clock();
    let latest = Number.NaN;
    for (const s of seriesRef.current) {
      const lt = s.buffer.lastTime;
      if (Number.isFinite(lt) && !(lt <= latest)) latest = lt;
    }
    return latest;
  }, []);

  // Freeze the right edge at the moment of pausing.
  useEffect(() => {
    pausedRef.current = paused;
    if (paused && Number.isNaN(view.current.end)) view.current.end = liveNow();
    if (!paused) view.current.end = Number.NaN;
    view.current.dirty = true;
  }, [paused, liveNow]);

  const windowRef = useRef(windowSpan);
  windowRef.current = windowSpan;
  const resetView = useCallback(() => {
    const v = view.current;
    v.span = windowRef.current;
    if (pausedRef.current) v.end = liveNow();
    v.dirty = true;
    setSpan(windowRef.current);
  }, [liveNow]);

  useEffect(() => {
    view.current.span = windowSpan;
    view.current.dirty = true;
    setSpan(windowSpan);
  }, [windowSpan]);

  const colors = useMemo(
    () => series.map((s, i) => resolvedSeriesColor(s, i)),
    // `theme` is a dependency because token colors resolve differently per theme.
    [series, theme],
  );

  const writeLegend = useCallback((at: number | null) => {
    const ss = seriesRef.current;
    const l = currentLang();
    if (headerEl.current) {
      headerEl.current.textContent =
        at === null ? translate('ui.chart.latest') : `${translate('ui.chart.cursor')} · ${fmtNumber(at, 3, { lang: l, grouping: false })} s`;
    }
    for (let i = 0; i < ss.length; i++) {
      const el = valueEls.current[i];
      const s = ss[i];
      if (!el || !s) continue;
      const v = at === null ? s.buffer.lastValue : s.buffer.valueNear(at);
      el.textContent = fmtValue(v, s.unit, s.digits ?? 2, { lang: l });
    }
  }, []);

  // Rebuild uPlot only when the *shape* of the chart changes, not on every render.
  const signature = series
    .map((s) => [s.key, s.label, s.color, s.unit, s.axis, s.width, s.dash?.join(',')].join('|'))
    .join(';');
  const scaleSig = JSON.stringify([yLeft, yRight]);

  useEffect(() => {
    const el = plotRef.current;
    if (!el) return;
    const ss = seriesRef.current;
    const opts = buildOptions({
      width: Math.max(1, el.clientWidth),
      height: Math.max(1, el.clientHeight),
      series: ss.map((s) => ({ ...s, visible: !hiddenRef.current.has(s.key) })),
      xRange: () => [view.current.t0, view.current.t1],
      yLeft,
      yRight,
      xUnit,
      onCursor: (u) => {
        const left = u.cursor.left ?? -1;
        cursorT.current = left >= 0 ? u.posToVal(left, 'x') : null;
        writeLegend(cursorT.current);
      },
    });
    const u = new uPlot(opts, [new Float64Array(0), ...ss.map(() => [])], el);
    uRef.current = u;
    view.current.dirty = true;

    const detach = attachInteractions(u, {
      zoom: (factor, at) => {
        const v = view.current;
        const next = Math.min(MAX_SPAN, Math.max(MIN_SPAN, v.span * factor));
        if (pausedRef.current && Number.isFinite(at)) {
          const t0 = at - (at - v.t0) * (next / v.span);
          v.end = t0 + next;
        }
        v.span = next;
        v.dirty = true;
        setSpan(next);
      },
      pan: (dt) => {
        const v = view.current;
        if (!pausedRef.current) {
          v.end = v.t1;
          pausedRef.current = true;
          setPausedRef.current(true);
        }
        v.end += dt;
        v.dirty = true;
        return true;
      },
      reset: resetView,
    });
    const unobserve = observeSize(el, (w, h) => {
      u.setSize({ width: w, height: h });
      view.current.dirty = true;
    });
    return () => {
      unobserve();
      detach();
      u.destroy();
      uRef.current = null;
    };
    // Rebuild on structural/theme/language changes only; data flows through refs.
  }, [signature, scaleSig, theme, lang, xUnit, liveNow, writeLegend, resetView]);

  // Render loop.
  useEffect(() => {
    let raf = 0;
    let xs = new Float64Array(0);
    let ys: (number | null)[][] = [];
    let lastVersions = '';
    let lastLegend = 0;
    const frame = (ts: number): void => {
      raf = requestAnimationFrame(frame);
      const u = uRef.current;
      if (!u) return;
      const ss = seriesRef.current;
      const v = view.current;
      const end = pausedRef.current ? v.end : liveNow();
      const t1 = Number.isFinite(end) ? end : 0;
      const t0 = t1 - v.span;
      let versions = '';
      for (const s of ss) versions += `${s.buffer.version},`;
      const moved = t0 !== v.t0 || t1 !== v.t1;
      // While paused, new samples outside the frozen window need no redraw.
      if (!v.dirty && !moved && (pausedRef.current || versions === lastVersions)) return;
      v.t0 = t0;
      v.t1 = t1;
      v.dirty = false;
      lastVersions = versions;

      const buckets = Math.max(16, Math.min(4096, Math.round(u.bbox.width / uPlot.pxRatio) || 600));
      if (xs.length !== buckets * 2 || ys.length !== ss.length) {
        xs = new Float64Array(buckets * 2);
        ys = ss.map(() => new Array<number | null>(buckets * 2).fill(null));
      }
      decimationGrid(t0, t1, buckets, xs);
      const hid = hiddenRef.current;
      for (let i = 0; i < ss.length; i++) {
        const s = ss[i];
        const out = ys[i];
        if (!s || !out) continue;
        if (hid.has(s.key)) out.fill(null);
        else s.buffer.decimate(t0, t1, buckets, out);
      }
      u.setData([xs, ...ys], true);

      if (cursorT.current !== null) writeLegend(cursorT.current);
      else if (ts - lastLegend > LEGEND_LATEST_MS) {
        lastLegend = ts;
        writeLegend(null);
      }
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [liveNow, writeLegend]);

  // Re-render legend text after language change.
  useEffect(() => writeLegend(cursorT.current), [lang, writeLegend, signature]);

  const toggle = useCallback((key: string) => {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      const idx = seriesRef.current.findIndex((s) => s.key === key);
      uRef.current?.setSeries(idx + 1, { show: !next.has(key) });
      view.current.dirty = true;
      return next;
    });
  }, []);

  const legendStyles = useMemo(() => series.map(({ buffer: _b, ...style }) => style), [series]);

  return (
    <div
      className={`cy-chart cy-chart--legend-${legend}${paused ? ' is-paused' : ''}${className ? ` ${className}` : ''}`}
      style={height ? { height } : undefined}
    >
      {toolbar && (
        <div className="cy-chart__toolbar">
          <span className={`cy-chart__mode${paused ? ' is-paused' : ''}`}>
            <span className="cy-chart__mode-dot" aria-hidden />
            {paused ? t('ui.chart.paused') : t('ui.chart.live')}
          </span>
          {title && <span className="cy-chart__title">{title}</span>}
          <span className="cy-chart__span cy-mono" title={t('ui.chart.hint')}>
            {t('ui.chart.window')} {fmtValue(span, 's', span < 1 ? 3 : span < 10 ? 2 : 1)}
          </span>
          <span className="cy-chart__spacer" />
          {actions}
          <IconButton
            size="sm"
            icon={Maximize2}
            label={t('ui.chart.resetView')}
            onClick={resetView}
          />
          <IconButton
            size="sm"
            variant={paused ? 'primary' : 'secondary'}
            icon={paused ? Play : Pause}
            label={paused ? t('ui.chart.resume') : t('ui.chart.pause')}
            onClick={() => setPaused(!paused)}
          />
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
