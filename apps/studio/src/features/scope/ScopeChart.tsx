import { useEffect, useMemo, useRef } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import { currentLang, fmtNumber, fmtValue, useI18n } from '../../i18n';
import { SeriesBuffer, decimationGrid, resolveColor, useTheme } from '../../ui';
import type { Axis } from './layout';
import type { ScopeView } from './view';

export interface ChartSeries {
  id: string;
  label: string;
  unit: string;
  color: string;
  axis: Axis;
  visible: boolean;
  digits: number;
  buffer: SeriesBuffer | undefined;
}

export interface ScopeChartProps {
  view: ScopeView;
  series: readonly ChartSeries[];
}

const CURSOR_GRAB_PX = 7;

function tickDigits(incr: number): number {
  if (!Number.isFinite(incr) || incr <= 0) return 0;
  return Math.max(0, Math.min(6, Math.ceil(-Math.log10(incr) - 1e-9)));
}

function yRange(): uPlot.Range.Function {
  return (_u, min, max) => {
    if (min == null || max == null || !Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
    if (min === max) {
      const pad = Math.abs(min) * 0.1 || 1;
      return [min - pad, max + pad];
    }
    const r = uPlot.rangeNum(min, max, 0.08, true);
    return [r[0] ?? min, r[1] ?? max];
  };
}

function unitsLabel(series: readonly ChartSeries[], axis: Axis): string {
  return [...new Set(series.filter((s) => s.axis === axis && s.unit).map((s) => s.unit))].join(' · ');
}

/**
 * One pane of the oscilloscope: uPlot fed by min/max-decimated ring buffers, with the time
 * axis, pause state and cursors taken from the shared `ScopeView`. Wheel zooms, dragging
 * pans (and pauses), a click without movement places a cursor, cursor lines can be dragged.
 */
export function ScopeChart({ view, series }: ScopeChartProps) {
  const { lang } = useI18n();
  const theme = useTheme((s) => s.theme);
  const plotRef = useRef<HTMLDivElement>(null);
  const readoutRef = useRef<HTMLDivElement>(null);
  const uRef = useRef<uPlot | null>(null);
  const seriesRef = useRef(series);
  seriesRef.current = series;
  const win = useRef({ t0: 0, t1: 1, dirty: true });
  const hoverT = useRef<number | null>(null);

  const signature = useMemo(() => series.map((s) => [s.id, s.color, s.axis, s.visible, s.unit, s.label].join('|')).join(';'), [series]);

  const writeReadout = (): void => {
    const el = readoutRef.current;
    if (!el) return;
    const t = hoverT.current;
    el.hidden = t === null;
    if (t === null) return;
    const l = currentLang();
    const rows = el.children;
    (rows[0] as HTMLElement | undefined)?.replaceChildren(`${fmtNumber(t, 3, { lang: l, grouping: false })} s`);
    seriesRef.current.forEach((s, i) => {
      const row = rows[i + 1] as HTMLElement | undefined;
      if (!row) return;
      const v = s.buffer ? s.buffer.valueNear(t) : NaN;
      (row.lastElementChild as HTMLElement | null)?.replaceChildren(fmtValue(v, s.unit, s.digits, { lang: l }));
    });
  };

  // New buffers (mode switch, layout change) need a repaint even when the shape is unchanged.
  useEffect(() => {
    win.current.dirty = true;
  }, [series]);

  useEffect(() => {
    const el = plotRef.current;
    if (!el) return;
    const ss = seriesRef.current;
    const hasRight = ss.some((s) => s.axis === 'right');
    const axisColor = resolveColor('chart-axis');
    const gridColor = resolveColor('chart-grid');
    const accent = resolveColor('accent');
    const mono = getComputedStyle(document.documentElement).getPropertyValue('--cy-font-mono') || 'monospace';
    const font = `500 10.5px ${mono}`;
    const labelFont = '700 10.5px Lato, sans-serif';
    const fmtTicks =
      (suffix: string) =>
      (_u: uPlot, splits: number[], _a: number, _s: number, incr: number): string[] =>
        splits.map((v) => `${fmtNumber(v, tickDigits(incr), { lang: currentLang(), grouping: false })}${suffix}`);
    const base: uPlot.Axis = {
      stroke: axisColor,
      font,
      labelFont,
      grid: { stroke: gridColor, width: 1 },
      ticks: { stroke: gridColor, width: 1, size: 4 },
      border: { show: false },
      gap: 4,
    };
    const axes: uPlot.Axis[] = [
      { ...base, scale: 'x', values: fmtTicks(' s'), size: 26, space: 80 },
      { ...base, scale: 'y', side: 3, values: fmtTicks(''), size: 54, space: 30, label: unitsLabel(ss, 'left'), labelSize: 14, labelGap: 2 },
    ];
    if (hasRight) {
      axes.push({ ...base, scale: 'y2', side: 1, values: fmtTicks(''), size: 54, space: 30, grid: { show: false }, label: unitsLabel(ss, 'right'), labelSize: 14, labelGap: 2 });
    }
    const scales: uPlot.Scales = { x: { time: false, range: () => [win.current.t0, win.current.t1] }, y: { auto: true, range: yRange() } };
    if (hasRight) scales.y2 = { auto: true, range: yRange() };

    const drawCursors = (u: uPlot): void => {
      const [a, b] = view.cursors;
      const ctx = u.ctx;
      const { left, top, width, height } = u.bbox;
      const px = uPlot.pxRatio;
      const xs = ([a, b] as const).map((t) => (t === null ? null : u.valToPos(t, 'x', true)));
      ctx.save();
      ctx.beginPath();
      ctx.rect(left, top, width, height);
      ctx.clip();
      const [xa, xb] = xs;
      if (xa != null && xb != null) {
        ctx.fillStyle = `${accent}1f`;
        ctx.fillRect(Math.min(xa, xb), top, Math.abs(xb - xa), height);
      }
      xs.forEach((x, i) => {
        if (x == null) return;
        ctx.strokeStyle = accent;
        ctx.lineWidth = 1.5 * px;
        ctx.setLineDash([5 * px, 3 * px]);
        ctx.beginPath();
        ctx.moveTo(x, top);
        ctx.lineTo(x, top + height);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = accent;
        ctx.fillRect(x - 8 * px, top, 16 * px, 14 * px);
        ctx.fillStyle = resolveColor('text-on-accent');
        ctx.font = `800 ${10 * px}px Lato, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(i === 0 ? 'A' : 'B', x, top + 7.5 * px);
      });
      ctx.restore();
    };

    const u = new uPlot(
      {
        width: Math.max(1, el.clientWidth),
        height: Math.max(1, el.clientHeight),
        pxAlign: 0,
        padding: [10, hasRight ? 4 : 14, 0, 4],
        legend: { show: false },
        scales,
        axes,
        cursor: { drag: { x: false, y: false, setScale: false }, points: { show: false }, y: false, x: true },
        series: [
          {},
          ...ss.map(
            (s): uPlot.Series => ({
              label: s.label,
              scale: s.axis === 'right' ? 'y2' : 'y',
              stroke: resolveColor(s.color),
              width: 1.5,
              spanGaps: true,
              points: { show: false },
              show: s.visible,
            }),
          ),
        ],
        hooks: {
          setCursor: [
            (uu) => {
              const left = uu.cursor.left ?? -1;
              hoverT.current = left >= 0 ? uu.posToVal(left, 'x') : null;
              writeReadout();
            },
          ],
          draw: [drawCursors],
        },
      },
      [new Float64Array(0), ...ss.map(() => [])],
      el,
    );
    uRef.current = u;
    win.current.dirty = true;

    // --- interaction -------------------------------------------------------------------
    const over = u.over;
    const timeAt = (clientX: number): number => u.posToVal(clientX - over.getBoundingClientRect().left, 'x');
    const nearestCursor = (clientX: number): 0 | 1 | null => {
      const rect = over.getBoundingClientRect();
      let best: 0 | 1 | null = null;
      let bestD = CURSOR_GRAB_PX;
      view.cursors.forEach((t, i) => {
        if (t === null) return;
        const d = Math.abs(rect.left + u.valToPos(t, 'x') - clientX);
        if (d <= bestD) {
          bestD = d;
          best = i as 0 | 1;
        }
      });
      return best;
    };
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      view.zoom(Math.exp(Math.max(-1, Math.min(1, e.deltaY / 300))), timeAt(e.clientX));
    };
    let startX = 0;
    let lastX = 0;
    let moved = false;
    let grabbed: 0 | 1 | null = null;
    let down = false;
    const onMove = (e: MouseEvent): void => {
      if (!down) return;
      if (grabbed !== null) {
        view.setCursor(grabbed, timeAt(e.clientX));
        moved = true;
        return;
      }
      if (!moved && Math.abs(e.clientX - startX) < 4) return;
      moved = true;
      const width = over.clientWidth || 1;
      view.pan(((lastX - e.clientX) / width) * view.span);
      lastX = e.clientX;
      over.style.cursor = 'grabbing';
    };
    const onUp = (e: MouseEvent): void => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      over.style.cursor = '';
      if (down && !moved && grabbed === null) view.placeCursor(timeAt(e.clientX));
      down = false;
      grabbed = null;
    };
    const onDown = (e: MouseEvent): void => {
      if (e.button !== 0) return;
      down = true;
      moved = false;
      startX = lastX = e.clientX;
      grabbed = nearestCursor(e.clientX);
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    };
    const onHover = (e: MouseEvent): void => {
      over.style.cursor = !down && nearestCursor(e.clientX) !== null ? 'ew-resize' : '';
    };
    over.addEventListener('wheel', onWheel, { passive: false });
    over.addEventListener('mousedown', onDown);
    over.addEventListener('mousemove', onHover);
    over.addEventListener('mouseleave', () => {
      hoverT.current = null;
      writeReadout();
    });

    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (!r) return;
      u.setSize({ width: Math.max(1, Math.floor(r.width)), height: Math.max(1, Math.floor(r.height)) });
      win.current.dirty = true;
    });
    ro.observe(el);

    // --- render loop -------------------------------------------------------------------
    let raf = 0;
    let xs: Float64Array = new Float64Array(0);
    let ys: (number | null)[][] = [];
    let lastVersions = '';
    let lastRev = -1;
    const frame = (): void => {
      raf = requestAnimationFrame(frame);
      const cur = seriesRef.current;
      const [t0, t1] = view.range();
      let versions = '';
      for (const s of cur) versions += `${s.buffer?.version ?? -1},`;
      const w = win.current;
      const moved2 = t0 !== w.t0 || t1 !== w.t1;
      if (!w.dirty && !moved2 && view.rev === lastRev && (view.paused || versions === lastVersions)) {
        if (hoverT.current !== null && !view.paused) writeReadout();
        return;
      }
      w.t0 = t0;
      w.t1 = t1;
      w.dirty = false;
      lastRev = view.rev;
      lastVersions = versions;
      const buckets = Math.max(16, Math.min(4096, Math.round(u.bbox.width / uPlot.pxRatio) || 600));
      if (xs.length !== buckets * 2 || ys.length !== cur.length) {
        xs = new Float64Array(buckets * 2);
        ys = cur.map(() => new Array<number | null>(buckets * 2).fill(null));
      }
      decimationGrid(t0, t1, buckets, xs);
      cur.forEach((s, i) => {
        const out = ys[i];
        if (!out) return;
        if (!s.visible || !s.buffer) out.fill(null);
        else s.buffer.decimate(t0, t1, buckets, out);
      });
      u.setData([xs, ...ys], true);
      if (hoverT.current !== null) writeReadout();
    };
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      over.removeEventListener('wheel', onWheel);
      over.removeEventListener('mousedown', onDown);
      over.removeEventListener('mousemove', onHover);
      u.destroy();
      uRef.current = null;
    };
    // The plot is rebuilt only when its shape or the theme changes; data flows through refs.
  }, [signature, theme, lang, view]);

  return (
    <div className="scope-chart">
      <div ref={plotRef} className="scope-chart__plot" />
      <div ref={readoutRef} className="scope-chart__readout" hidden>
        <div className="scope-chart__readout-t cy-mono" />
        {series.map((s) => (
          <div key={s.id} className={`scope-chart__readout-row${s.visible ? '' : ' is-off'}`}>
            <span className="scope-chart__dot" style={{ background: `var(--cy-${s.color})` }} />
            <span className="scope-chart__readout-label">{s.label}</span>
            <span className="cy-mono" />
          </div>
        ))}
      </div>
    </div>
  );
}
