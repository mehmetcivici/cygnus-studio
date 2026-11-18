/** Read-only view of a time series; `SeriesBuffer` satisfies it. */
export interface SampleSeries {
  readonly length: number;
  timeAt(i: number): number;
  valueAt(i: number): number;
  /** Index of the first sample with time >= t (`length` when none). */
  lowerBound(t: number): number;
}

export interface RangeStats {
  count: number;
  min: number;
  max: number;
  /** Arithmetic mean of the samples (STATUS and stream samples are evenly spaced). */
  mean: number;
  rms: number;
}

/** Statistics of the finite samples with `t0 <= t <= t1`; null when there are none. */
export function rangeStats(s: SampleSeries, t0: number, t1: number): RangeStats | null {
  if (!(t1 >= t0)) return null;
  let count = 0;
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let sumSq = 0;
  for (let i = s.lowerBound(t0); i < s.length; i++) {
    if (s.timeAt(i) > t1) break;
    const v = s.valueAt(i);
    if (!Number.isFinite(v)) continue;
    count++;
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
    sumSq += v * v;
  }
  return count ? { count, min, max, mean: sum / count, rms: Math.sqrt(sumSq / count) } : null;
}

/** Value of the sample nearest to `t`, NaN for an empty series. */
export function valueAtTime(s: SampleSeries, t: number): number {
  const n = s.length;
  if (!n) return NaN;
  const i = s.lowerBound(t);
  if (i >= n) return s.valueAt(n - 1);
  if (i === 0) return s.valueAt(0);
  return t - s.timeAt(i - 1) <= s.timeAt(i) - t ? s.valueAt(i - 1) : s.valueAt(i);
}

export interface CursorDelta {
  /** Signed: B minus A, seconds. */
  dt: number;
  /** 1 / |dt|, Hz; null when the cursors coincide. */
  freq: number | null;
}

export function cursorDelta(a: number, b: number): CursorDelta {
  const dt = b - a;
  return { dt, freq: dt === 0 ? null : 1 / Math.abs(dt) };
}

export interface SignalMeasure {
  atA: number;
  atB: number;
  dy: number;
  /** Statistics between the cursors (inclusive); null when no sample lies between them. */
  between: RangeStats | null;
}

export function measureSignal(s: SampleSeries, a: number, b: number): SignalMeasure {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  const atA = valueAtTime(s, a);
  const atB = valueAtTime(s, b);
  return { atA, atB, dy: atB - atA, between: rangeStats(s, lo, hi) };
}
