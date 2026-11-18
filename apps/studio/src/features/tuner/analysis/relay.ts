import { idealToParallel, type Pid } from './tuning';
import type { Vec } from './numeric';
import type { ProcessModel } from './model';

export interface RelayResult {
  /** Ultimate gain (output units per measured unit) and period, s. */
  ku: number;
  tu: number;
  /** Oscillation amplitude of the measurement (half peak-to-peak) and relay amplitude. */
  a: number;
  d: number;
  /** Full oscillation periods used. */
  cycles: number;
  /** Relative spread of the measured periods (0 = perfectly regular). */
  spread: number;
}

/**
 * Åström–Hägglund relay analysis. `u` is the applied relay output and `y` the measurement; the
 * describing function of an ideal relay gives Ku = 4d / (π·a) (with hysteresis ε:
 * 4d / (π·√(a² − ε²))). The first `skip` crossings (start-up transient) are ignored.
 */
export function analyzeRelay(t: Vec, u: Vec, y: Vec, opts: { hysteresis?: number; skip?: number } = {}): RelayResult | null {
  const n = t.length;
  if (n < 20) return null;
  // Relay switching instants: sign changes of u around its mid level.
  let uMin = Infinity;
  let uMax = -Infinity;
  for (let i = 0; i < n; i++) {
    const v = u[i]!;
    if (!Number.isFinite(v)) continue;
    if (v < uMin) uMin = v;
    if (v > uMax) uMax = v;
  }
  if (!(uMax > uMin)) return null;
  const mid = (uMax + uMin) / 2;
  const up: number[] = [];
  let prev = 0;
  for (let i = 0; i < n; i++) {
    const v = u[i]!;
    if (!Number.isFinite(v)) continue;
    const s = v > mid ? 1 : -1;
    if (prev === -1 && s === 1) up.push(i);
    prev = s;
  }
  const skip = opts.skip ?? 1;
  const edges = up.slice(skip);
  if (edges.length < 3) return null;
  const periods: number[] = [];
  const amps: number[] = [];
  const dHigh: number[] = [];
  const dLow: number[] = [];
  for (let k = 0; k + 1 < edges.length; k++) {
    const a = edges[k]!;
    const b = edges[k + 1]!;
    periods.push(t[b]! - t[a]!);
    let lo = Infinity;
    let hi = -Infinity;
    let uh = 0;
    let nh = 0;
    let ul = 0;
    let nl = 0;
    for (let i = a; i < b; i++) {
      const yi = y[i]!;
      if (Number.isFinite(yi)) {
        if (yi < lo) lo = yi;
        if (yi > hi) hi = yi;
      }
      const ui = u[i]!;
      if (!Number.isFinite(ui)) continue;
      if (ui > mid) {
        uh += ui;
        nh++;
      } else {
        ul += ui;
        nl++;
      }
    }
    amps.push((hi - lo) / 2);
    if (nh) dHigh.push(uh / nh);
    if (nl) dLow.push(ul / nl);
  }
  const avg = (a: number[]): number => a.reduce((s, v) => s + v, 0) / a.length;
  const tu = avg(periods);
  const a = avg(amps);
  const d = (avg(dHigh) - avg(dLow)) / 2;
  const eps = opts.hysteresis ?? 0;
  if (!(a > eps) || !(tu > 0) || !(d > 0)) return null;
  const ku = (4 * d) / (Math.PI * Math.sqrt(a * a - eps * eps));
  const spread = Math.sqrt(avg(periods.map((p) => (p - tu) ** 2))) / tu;
  return { ku, tu, a, d, cycles: periods.length, spread };
}

export type RelayRule = 'zn-p' | 'zn-pi' | 'zn-pid' | 'tl-pi' | 'tl-pid';

/** Ziegler–Nichols and Tyreus–Luyben tables from (Ku, Tu). */
export function relayTuning(ku: number, tu: number, rule: RelayRule): Pid {
  switch (rule) {
    case 'zn-p':
      return idealToParallel(0.5 * ku, Infinity, 0);
    case 'zn-pi':
      return idealToParallel(0.45 * ku, tu / 1.2, 0);
    case 'zn-pid':
      return idealToParallel(0.6 * ku, tu / 2, tu / 8);
    case 'tl-pi':
      return idealToParallel(ku / 3.2, 2.2 * tu, 0);
    case 'tl-pid':
      return idealToParallel(ku / 2.2, 2.2 * tu, tu / 6.3);
  }
}

export const RELAY_RULES: readonly RelayRule[] = ['zn-p', 'zn-pi', 'zn-pid', 'tl-pi', 'tl-pid'];

/**
 * Ultimate gain and period of a model (phase −180° crossing), for comparing a relay result
 * with an identified model. Null when the phase never reaches −180° (no dead time, no lag).
 */
export function modelUltimate(m: ProcessModel): { ku: number; tu: number } | null {
  const K = Math.abs(m.K);
  if (!(K > 0)) return null;
  // Phase lag beyond the integrator/lag terms: atan(ωτ) + ωθ (+ π/2 for integrating).
  const target = m.kind === 'integrating' ? Math.PI / 2 : Math.PI;
  const lag = (w: number): number => Math.atan(w * m.tau) + w * m.theta;
  if (m.theta <= 0 && (m.kind === 'fopdt' || m.tau <= 0)) return null;
  let lo = 1e-6;
  let hi = 1e7;
  if (lag(hi) < target) return null;
  for (let i = 0; i < 200; i++) {
    const mid = Math.sqrt(lo * hi);
    if (lag(mid) < target) lo = mid;
    else hi = mid;
  }
  const w = lo;
  const mag = (K * (m.kind === 'integrating' ? 1 / w : 1)) / Math.sqrt(1 + (w * m.tau) ** 2);
  return { ku: 1 / mag, tu: (2 * Math.PI) / w };
}
