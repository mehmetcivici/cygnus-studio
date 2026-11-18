import { derivative, leastSquares, mean, resample, smooth, type Vec } from './numeric';

export interface FeedforwardFit {
  kS: number;
  kV: number;
  kA: number;
  r2: number;
  /** Samples used after excluding the current-limited and near-standstill ones. */
  samples: number;
}

export interface FeedforwardOptions {
  /** Current record and limit: samples at the limit do not follow the linear model. */
  current?: Vec;
  currentLimit?: number;
  /** Below this |ω| the sign of the friction term is unreliable (default 1 % of max |ω|). */
  minSpeed?: number;
  /** Smoothing time constant before differentiation, s (default 10 ms). */
  smoothTau?: number;
}

/**
 * Least-squares fit of V = kS·sgn(ω) + kV·ω + kA·α to quasi-static ramps and steps.
 * `u` is the applied loop output (V), `w` the measured velocity; α = dω/dt is taken from a
 * zero-phase smoothed copy so noise does not swamp it.
 */
export function fitFeedforward(t: Vec, u: Vec, w: Vec, o: FeedforwardOptions = {}): FeedforwardFit | null {
  const chans: Vec[] = [u, w];
  if (o.current) chans.push(o.current);
  const r = resample(t, chans);
  const dt = r.dt;
  const uu = r.ch[0]!;
  const ws = smooth(r.ch[1]!, o.smoothTau ?? 0.01, dt);
  const cur = r.ch[2];
  const n = uu.length;
  if (n < 20) return null;
  const alpha = derivative(ws, dt, Math.max(1, Math.round(0.005 / dt)));
  let wMax = 0;
  for (let i = 0; i < n; i++) wMax = Math.max(wMax, Math.abs(ws[i]!));
  if (!(wMax > 0)) return null;
  const minSpeed = o.minSpeed ?? 0.01 * wMax;
  const use = new Uint8Array(n);
  let count = 0;
  for (let i = 0; i < n; i++) {
    const limited = cur && o.currentLimit !== undefined && Math.abs(cur[i]!) >= 0.9 * o.currentLimit;
    if (Math.abs(ws[i]!) >= minSpeed && !limited && Number.isFinite(uu[i]!)) {
      use[i] = 1;
      count++;
    }
  }
  if (count < 10) return null;
  const idx = new Int32Array(count);
  for (let i = 0, k = 0; i < n; i++) if (use[i]) idx[k++] = i;
  const beta = leastSquares(count, 3, (k, row) => {
    const i = idx[k]!;
    row[0] = Math.sign(ws[i]!);
    row[1] = ws[i]!;
    row[2] = alpha[i]!;
    return uu[i]!;
  });
  if (!beta.every(Number.isFinite)) return null;
  const [kS, kV, kA] = [beta[0]!, beta[1]!, beta[2]!];
  const um = mean(Array.from(idx, (i) => uu[i]!));
  let ssr = 0;
  let sst = 0;
  for (let k = 0; k < count; k++) {
    const i = idx[k]!;
    const pred = kS * Math.sign(ws[i]!) + kV * ws[i]! + kA * alpha[i]!;
    ssr += (uu[i]! - pred) ** 2;
    sst += (uu[i]! - um) ** 2;
  }
  return { kS, kV, kA, r2: sst > 0 ? 1 - ssr / sst : 0, samples: count };
}
