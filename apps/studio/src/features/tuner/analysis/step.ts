import { detrendedRms, mean, type Vec } from './numeric';

/** One target edge found in a record (indices into the record). */
export interface StepEdge {
  index: number;
  /** Time of the edge as the board saw it, s. */
  t: number;
  from: number;
  to: number;
  /** Last index (exclusive) that belongs to this step. */
  end: number;
}

/**
 * Finds step edges in the streamed target. A jump counts when it is a sizeable share of the
 * target's whole span; ramps and sweeps therefore produce no edges.
 */
export function detectSteps(t: Vec, target: Vec, minShare = 0.2): StepEdge[] {
  const n = target.length;
  if (n < 3) return [];
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < n; i++) {
    const v = target[i]!;
    if (!Number.isFinite(v)) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const span = hi - lo;
  if (!(span > 0)) return [];
  const edges: StepEdge[] = [];
  let prev = target[0]!;
  for (let i = 1; i < n; i++) {
    const v = target[i]!;
    if (!Number.isFinite(v)) continue;
    if (Math.abs(v - prev) >= minShare * span) edges.push({ index: i, t: t[i]!, from: prev, to: v, end: n });
    prev = v;
  }
  for (let k = 0; k < edges.length - 1; k++) edges[k]!.end = edges[k + 1]!.index;
  return edges;
}

export interface StepOptions {
  /** Loop output record and its saturation limit (absolute). */
  output?: Vec;
  outputLimit?: number;
  /** Current record and its limit; time spent at the current limit also counts as saturation. */
  current?: Vec;
  currentLimit?: number;
  /** Settling band as a share of the step (default 0.02). */
  band?: number;
}

export interface StepMetrics {
  /** Edge time, s (record time base). */
  t0: number;
  from: number;
  to: number;
  /** Measured value just before the edge and at the end of the window. */
  y0: number;
  yFinal: number;
  riseTime: number;
  peakTime: number;
  /** Overshoot past the final value, % of the response (0 when none). */
  overshoot: number;
  settlingTime: number;
  /** target − final measured value (units) and as % of the step. */
  steadyError: number;
  steadyErrorPct: number;
  iae: number;
  itae: number;
  /** Damping ratio estimate (logarithmic decrement, or from overshoot for a single peak). */
  damping: number;
  /** Count of overshoot peaks (half-oscillations past the final value). */
  oscillations: number;
  /** Share of the window with the output (or current) at its limit, %. */
  saturation: number;
  /** Measurement noise in the steady window (RMS after detrending). */
  noiseRms: number;
  /** Settling band actually used (units), widened above 2 % when noise would never fit in it. */
  bandUsed: number;
  /** Window length analysed, s. */
  window: number;
  /**
   * The measurement barely moved (< 5 % of the step, or inside the noise): rise, peak,
   * overshoot and damping are then meaningless and reported as NaN.
   */
  noResponse: boolean;
}

/**
 * Step response metrics of `measured` after one target edge. Times are relative to the edge as
 * stamped by the board, so host latency never shifts them.
 */
export function stepMetrics(t: Vec, target: Vec, measured: Vec, edge: StepEdge, o: StepOptions = {}): StepMetrics {
  const i0 = edge.index;
  const i1 = Math.max(i0 + 2, edge.end);
  const t0 = edge.t;
  const pre = Math.max(0, i0 - Math.max(3, Math.round((i1 - i0) * 0.02)));
  const y0raw = mean(measured, pre, i0);
  const y0 = Number.isFinite(y0raw) ? y0raw : (measured[i0] ?? NaN);
  const n = i1 - i0;
  // Final value: mean over the last 15 % of the window.
  const tailFrom = i1 - Math.max(3, Math.round(n * 0.15));
  const yFinal = mean(measured, tailFrom, i1);
  const target1 = edge.to;
  const dy = yFinal - y0;
  const dir = Math.sign(target1 - edge.from) || 1;
  const noise = detrendedRms(t, measured, tailFrom, i1);
  const stepSize = Math.abs(target1 - edge.from);
  const band = Math.max((o.band ?? 0.02) * Math.abs(dy), 2.5 * (Number.isFinite(noise) ? noise : 0));

  let rise10 = NaN;
  let rise90 = NaN;
  let peakIdx = i0;
  let peakVal = y0;
  let iae = 0;
  let itae = 0;
  let sat = 0;
  for (let i = i0; i < i1; i++) {
    const y = measured[i]!;
    if (!Number.isFinite(y)) continue;
    const frac = dy !== 0 ? (y - y0) / dy : 0;
    if (Number.isNaN(rise10) && frac >= 0.1) rise10 = t[i]! - t0;
    if (Number.isNaN(rise90) && frac >= 0.9) rise90 = t[i]! - t0;
    if ((y - peakVal) * dir > 0) {
      peakVal = y;
      peakIdx = i;
    }
    if (i > i0) {
      const dt = t[i]! - t[i - 1]!;
      const e = Math.abs((target[i] ?? target1) - y);
      iae += e * dt;
      itae += (t[i]! - t0) * e * dt;
    }
    const u = o.output?.[i];
    const atOut = o.outputLimit !== undefined && u !== undefined && Number.isFinite(u) && Math.abs(u) >= 0.98 * o.outputLimit;
    const c = o.current?.[i];
    const atCur = o.currentLimit !== undefined && c !== undefined && Number.isFinite(c) && Math.abs(c) >= 0.95 * o.currentLimit;
    if (atOut || atCur) sat++;
  }
  // A peak inside the settling band (final-value averaging, noise) is not overshoot.
  const over = dy !== 0 && Math.abs(peakVal - yFinal) > band ? ((peakVal - yFinal) / dy) * 100 : 0;
  const overshoot = Math.max(0, over);

  // Settling: last sample outside the band around the final value.
  let lastOut = -1;
  for (let i = i0; i < i1; i++) {
    const y = measured[i]!;
    if (Number.isFinite(y) && Math.abs(y - yFinal) > band) lastOut = i;
  }
  const settled = lastOut < i1 - Math.max(3, Math.round(n * 0.1));
  const settlingTime = lastOut < 0 ? 0 : settled ? t[Math.min(i1 - 1, lastOut + 1)]! - t0 : NaN;

  const steadyError = target1 - yFinal;
  const noResponse = Math.abs(dy) < Math.max(0.05 * stepSize, 3 * (Number.isFinite(noise) ? noise : 0));
  if (noResponse) {
    return {
      t0,
      from: edge.from,
      to: target1,
      y0,
      yFinal,
      riseTime: NaN,
      peakTime: NaN,
      overshoot: NaN,
      settlingTime: NaN,
      steadyError,
      steadyErrorPct: stepSize > 0 ? (Math.abs(steadyError) / stepSize) * 100 : NaN,
      iae,
      itae,
      damping: NaN,
      oscillations: 0,
      saturation: n > 0 ? (sat / n) * 100 : 0,
      noiseRms: noise,
      bandUsed: band,
      window: t[i1 - 1]! - t0,
      noResponse: true,
    };
  }
  const { damping, peaks } = dampingEstimate(measured, i0, i1, yFinal, dy, band);
  return {
    t0,
    from: edge.from,
    to: target1,
    y0,
    yFinal,
    riseTime: rise90 - rise10,
    peakTime: overshoot > 0 ? t[peakIdx]! - t0 : NaN,
    overshoot,
    settlingTime,
    steadyError,
    steadyErrorPct: stepSize > 0 ? (Math.abs(steadyError) / stepSize) * 100 : NaN,
    iae,
    itae,
    damping,
    oscillations: peaks,
    saturation: n > 0 ? (sat / n) * 100 : 0,
    noiseRms: noise,
    bandUsed: band,
    window: t[i1 - 1]! - t0,
    noResponse: false,
  };
}

/**
 * Damping ratio from successive extremes of (y − yFinal) past the 50 % point. Two or more
 * same-sign extremes give the logarithmic decrement; a single overshoot falls back to the
 * second-order overshoot formula. Extremes inside the noise band are ignored.
 */
function dampingEstimate(y: Vec, i0: number, i1: number, yFinal: number, dy: number, band: number): { damping: number; peaks: number } {
  if (dy === 0) return { damping: NaN, peaks: 0 };
  const sgn = Math.sign(dy);
  // Start once the response crossed the final value for the first time.
  let start = -1;
  for (let i = i0; i < i1; i++) {
    const v = y[i]!;
    if (Number.isFinite(v) && (v - yFinal) * sgn >= 0) {
      start = i;
      break;
    }
  }
  if (start < 0) return { damping: 1, peaks: 0 };
  const ext: number[] = [];
  let curSign = 0;
  let curExt = 0;
  for (let i = start; i < i1; i++) {
    const v = y[i]!;
    if (!Number.isFinite(v)) continue;
    const d = (v - yFinal) * sgn;
    if (Math.abs(d) <= band) continue;
    const s = Math.sign(d);
    if (s !== curSign) {
      if (curSign !== 0) ext.push(curExt);
      curSign = s;
      curExt = d;
    } else if (Math.abs(d) > Math.abs(curExt)) curExt = d;
  }
  if (curSign !== 0) ext.push(curExt);
  const positive = ext.filter((e) => e > 0);
  const peaks = positive.length;
  if (peaks === 0) return { damping: 1, peaks: 0 };
  // Decrement over half periods (alternating extremes) is the most data-efficient.
  if (ext.length >= 2) {
    const ratios: number[] = [];
    for (let k = 0; k + 1 < ext.length; k++) {
      const a = Math.abs(ext[k]!);
      const b = Math.abs(ext[k + 1]!);
      if (a > 0 && b > 0 && b < a) ratios.push(Math.log(a / b));
    }
    if (ratios.length) {
      const halfDelta = ratios.reduce((s, r) => s + r, 0) / ratios.length;
      const delta = 2 * halfDelta;
      return { damping: delta / Math.sqrt(4 * Math.PI * Math.PI + delta * delta), peaks };
    }
  }
  const os = Math.abs(ext[0]! / dy);
  if (os <= 0 || os >= 1) return { damping: os >= 1 ? 0 : 1, peaks };
  const l = Math.log(os);
  return { damping: -l / Math.sqrt(Math.PI * Math.PI + l * l), peaks };
}

export type Grade = 'good' | 'fair' | 'poor' | 'info';

export type MetricKey =
  | 'riseTime'
  | 'peakTime'
  | 'overshoot'
  | 'settlingTime'
  | 'steadyError'
  | 'iae'
  | 'itae'
  | 'damping'
  | 'saturation'
  | 'noiseRms';

/** Tip identifiers; the screen maps them to plain-language sentences. */
export type TipKey =
  | 'noResponse'
  | 'overshootHigh'
  | 'overshootSome'
  | 'slow'
  | 'notSettled'
  | 'steadyError'
  | 'steadyErrorFf'
  | 'oscillating'
  | 'saturating'
  | 'noisy'
  | 'notReached'
  | 'good';

export interface MetricGrade {
  key: MetricKey;
  grade: Grade;
}

/** Steady error (% of the step) beyond which the time metrics describe a response that never arrived. */
export const NOT_REACHED_PCT = 10;
/** Metrics measured against the target: meaningless (shown as —, never "good") when it was not reached. */
export const TIME_METRICS: readonly MetricKey[] = ['riseTime', 'peakTime', 'overshoot', 'settlingTime', 'damping', 'iae', 'itae'];

/** False when the time metrics of this step describe a response that never arrived. */
export function reachedTarget(m: StepMetrics): boolean {
  return !m.noResponse && m.steadyErrorPct < NOT_REACHED_PCT;
}

/** Grades each metric and returns the tips that apply, most important first. */
export function gradeStep(
  m: StepMetrics,
  ctx: { hasKi: boolean; hasFf: boolean } = { hasKi: true, hasFf: false },
): { grades: MetricGrade[]; tips: TipKey[]; reached: boolean } {
  const step = Math.abs(m.to - m.from) || 1;
  const g = (key: MetricKey, grade: Grade): MetricGrade => ({ key, grade });
  const os = m.overshoot;
  const settleRatio = m.settlingTime / Math.max(1e-6, m.riseTime);
  const grades: MetricGrade[] = [
    g('riseTime', 'info'),
    g('peakTime', 'info'),
    g('overshoot', os < 5 ? 'good' : os < 20 ? 'fair' : 'poor'),
    g('settlingTime', Number.isNaN(m.settlingTime) ? 'poor' : settleRatio <= 4 ? 'good' : settleRatio <= 10 ? 'fair' : 'poor'),
    g('steadyError', m.steadyErrorPct < 1 ? 'good' : m.steadyErrorPct < 5 ? 'fair' : 'poor'),
    g('iae', 'info'),
    g('itae', 'info'),
    g('damping', !Number.isFinite(m.damping) ? 'info' : m.damping >= 0.6 ? 'good' : m.damping >= 0.3 ? 'fair' : 'poor'),
    g('saturation', m.saturation < 5 ? 'good' : m.saturation < 30 ? 'fair' : 'poor'),
    g('noiseRms', !Number.isFinite(m.noiseRms) ? 'info' : (m.noiseRms / step) * 100 < 0.5 ? 'good' : (m.noiseRms / step) * 100 < 2 ? 'fair' : 'poor'),
  ];
  const tips: TipKey[] = [];
  if (m.noResponse) {
    return {
      grades: grades.map((x) => (x.key === 'steadyError' || x.key === 'saturation' || x.key === 'noiseRms' ? x : { ...x, grade: x.key === 'settlingTime' ? 'poor' : 'info' })),
      tips: m.saturation >= 30 ? ['noResponse', 'saturating'] : ['noResponse'],
      reached: false,
    };
  }
  // A response that stops at 44 % of the step can be "fast and without overshoot": the time
  // metrics must not call that good (review: everything green while 56 % short).
  if (!(m.steadyErrorPct < NOT_REACHED_PCT)) {
    const out: TipKey[] = ['notReached'];
    if (m.saturation >= 30) out.push('saturating');
    out.push(ctx.hasFf && !ctx.hasKi ? 'steadyErrorFf' : 'steadyError');
    return { grades: grades.map((x) => (TIME_METRICS.includes(x.key) ? { ...x, grade: 'info' } : x)), tips: out, reached: false };
  }
  if (m.saturation >= 30) tips.push('saturating');
  if (os >= 20) tips.push('overshootHigh');
  else if (os >= 5) tips.push('overshootSome');
  if (Number.isFinite(m.damping) && m.damping < 0.3 && m.oscillations >= 2) tips.push('oscillating');
  if (m.steadyErrorPct >= 1) tips.push(ctx.hasFf && !ctx.hasKi ? 'steadyErrorFf' : 'steadyError');
  if (Number.isNaN(m.settlingTime)) tips.push('notSettled');
  else if (settleRatio > 10 && os < 5) tips.push('slow');
  if (Number.isFinite(m.noiseRms) && (m.noiseRms / step) * 100 >= 2) tips.push('noisy');
  if (!tips.length) tips.push('good');
  return { grades, tips, reached: true };
}

/** Single score for ranking runs (lower is better): ITAE normalised by the step size. */
export function stepScore(m: StepMetrics): number {
  if (m.noResponse) return Infinity;
  const step = Math.abs(m.to - m.from) || 1;
  const sse = Number.isFinite(m.steadyErrorPct) ? m.steadyErrorPct : 100;
  return m.itae / step + 0.01 * m.overshoot + 0.02 * sse;
}
