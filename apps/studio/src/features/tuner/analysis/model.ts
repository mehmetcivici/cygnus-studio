import { clamp, leastSquares, mean, nelderMead, resample, smooth, type Vec } from './numeric';

/**
 * Process models used for tuning. Units: input = loop output (e.g. V), output = measured
 * quantity (e.g. rpm or rot), times in seconds.
 *
 * - `fopdt` (self-regulating): τ·y' + y = K·u(t − θ) + c
 * - `integrating` (with lag): y' = v,  τ·v' + v = K·u(t − θ) + c   (τ = 0: pure integrator)
 *
 * `c` absorbs a constant load seen in the record (friction, gravity at the working point).
 */
export interface ProcessModel {
  kind: 'fopdt' | 'integrating';
  K: number;
  tau: number;
  theta: number;
  c: number;
}

export interface FitResult {
  model: ProcessModel;
  /** Coefficient of determination of the simulated output against the record. */
  r2: number;
  /** RMS of the output error (output units). */
  rms: number;
}

/**
 * Simulates a model on a uniform input record (sample period dt), starting from y0 at rest
 * (v = 0 for the integrating model). Fractional dead time is interpolated.
 */
export function simulateModel(m: ProcessModel, u: Vec, dt: number, y0: number, out = new Float64Array(u.length)): Float64Array {
  const n = u.length;
  const dShift = m.theta / dt;
  const d0 = Math.floor(dShift);
  const fr = dShift - d0;
  const uAt = (k: number): number => {
    const a = k - d0;
    const b = a - 1;
    const ua = a < 0 ? u[0]! : a >= n ? u[n - 1]! : u[a]!;
    const ub = b < 0 ? u[0]! : b >= n ? u[n - 1]! : u[b]!;
    return ua * (1 - fr) + ub * fr;
  };
  // Exact zero-order-hold discretisation of the first-order lag.
  const tau = Math.max(0, m.tau);
  const a = tau > 0 ? Math.exp(-dt / tau) : 0;
  if (m.kind === 'fopdt') {
    let y = y0;
    for (let k = 0; k < n; k++) {
      out[k] = y;
      y = a * y + (1 - a) * (m.K * uAt(k) + m.c);
    }
  } else {
    let y = y0;
    let v = 0;
    for (let k = 0; k < n; k++) {
      out[k] = y;
      const vIn = m.K * uAt(k) + m.c;
      const vNext = a * v + (1 - a) * vIn;
      y += 0.5 * (v + vNext) * dt;
      v = vNext;
    }
  }
  return out;
}

export interface IdentifyOptions {
  kind: ProcessModel['kind'];
  /** Resampling period (default: the record's median step, at least 1 ms). */
  dt?: number;
  /** Longest dead time to consider, s (default: 25 % of the record). */
  maxTheta?: number;
}

/**
 * Identifies a first-order-plus-dead-time (or integrating-with-lag) model from any record of
 * loop output `u` and measurement `y`: an open-loop step, a closed-loop step or relay data.
 * An equation-error (ARX) scan over dead times gives the start point; an output-error
 * Nelder–Mead refinement then removes the noise bias that ARX has.
 */
export function identify(t: Vec, u: Vec, y: Vec, o: IdentifyOptions): FitResult | null {
  if (t.length < 20) return null;
  const r = resample(t, [u, y], o.dt ? o.dt : undefined);
  let dt = r.dt;
  let uu = r.ch[0]!;
  let yy = r.ch[1]!;
  // Fits run on at most ~4000 points; decimate long records (average blocks, keeps the shape).
  const maxN = 4000;
  if (uu.length > maxN) {
    const f = Math.ceil(uu.length / maxN);
    uu = blockMean(uu, f);
    yy = blockMean(yy, f);
    dt *= f;
  }
  const n = uu.length;
  if (n < 10) return null;
  const y0 = mean(yy, 0, Math.max(1, Math.min(5, n)));
  const yVar = variance(yy);
  if (!(yVar > 0)) return null;
  const maxTheta = o.maxTheta ?? 0.25 * n * dt;
  // Equation-error estimates are biased by noise; run them on a smoothed copy (zero phase, so
  // no extra delay) and keep a crude moment-based start as a second candidate.
  const ys = smooth(yy, Math.max(dt, 0.004 * n * dt), dt);
  const starts: ProcessModel[] = [];
  const arx = arxStart(uu, ys, dt, o.kind, Math.max(1, Math.round(maxTheta / dt)));
  if (arx) starts.push(arx);
  const crude = crudeStart(uu, ys, dt, o.kind);
  if (crude) starts.push(crude);
  if (!starts.length) return null;

  const sim = new Float64Array(n);
  const cost = (p: Float64Array): number => {
    const m: ProcessModel = { kind: o.kind, K: p[0]!, tau: Math.exp(p[1]!), theta: clamp(p[2]!, 0, maxTheta), c: p[3]! };
    simulateModel(m, uu, dt, y0, sim);
    let s = 0;
    for (let k = 0; k < n; k++) {
      const e = yy[k]! - sim[k]!;
      s += e * e;
    }
    // Soft wall keeps θ in range.
    const over = p[2]! < 0 ? -p[2]! : p[2]! > maxTheta ? p[2]! - maxTheta : 0;
    return s / n + ((over / dt) ** 2) * yVar;
  };
  let best: { x: Float64Array; fx: number } | null = null;
  for (const start of starts) {
    const p0 = [start.K, Math.log(Math.max(start.tau, dt * 0.5)), clamp(start.theta, 0, maxTheta), start.c];
    const scaleK = Math.abs(start.K) > 0 ? Math.abs(start.K) * 0.2 : 1;
    const scaleC = Math.sqrt(yVar) * 0.05 + Math.abs(start.c) * 0.1 + 1e-9;
    let r = nelderMead(cost, p0, { step: [scaleK, 0.3, Math.max(2 * dt, start.theta * 0.3), scaleC], maxIter: 1500 });
    // A restart from the optimum escapes the occasional collapsed simplex.
    r = nelderMead(cost, Array.from(r.x), { step: [scaleK * 0.3, 0.1, Math.max(dt, r.x[2]! * 0.2), scaleC * 0.3], maxIter: 1000 });
    if (!best || r.fx < best.fx) best = r;
  }
  if (!best) return null;
  const p = best.x;
  const model: ProcessModel = { kind: o.kind, K: p[0]!, tau: Math.exp(p[1]!), theta: clamp(p[2]!, 0, maxTheta), c: p[3]! };
  if (o.kind === 'integrating' && model.tau < dt * 0.6) model.tau = 0;
  simulateModel(model, uu, dt, y0, sim);
  let ss = 0;
  for (let k = 0; k < n; k++) ss += (yy[k]! - sim[k]!) ** 2;
  const rms = Math.sqrt(ss / n);
  return { model, r2: 1 - ss / n / yVar, rms };
}

/**
 * Moment start: static gain from the input/output spread, τ from the time the output needs to
 * cover 63 % of its range after the largest input change.
 */
function crudeStart(u: Float64Array, y: Float64Array, dt: number, kind: ProcessModel['kind']): ProcessModel | null {
  const n = u.length;
  let kStep = 1;
  let best = 0;
  for (let k = 1; k < n; k++) {
    const d = Math.abs(u[k]! - u[k - 1]!);
    if (d > best) {
      best = d;
      kStep = k;
    }
  }
  const du = u[n - 1]! - u[Math.max(0, kStep - 1)]!;
  if (du === 0) return null;
  if (kind === 'fopdt') {
    const y0 = y[Math.max(0, kStep - 1)]!;
    const y1 = y[n - 1]!;
    const K = (y1 - y0) / du;
    let k63 = n - 1;
    for (let k = kStep; k < n; k++) {
      if ((y[k]! - y0) / (y1 - y0) >= 0.632) {
        k63 = k;
        break;
      }
    }
    return { kind, K, tau: Math.max(dt, (k63 - kStep) * dt), theta: 0, c: y0 - K * u[Math.max(0, kStep - 1)]! };
  }
  const v = diffOf(y, dt);
  const vEnd = mean(v, Math.floor(n * 0.9), n);
  return { kind, K: vEnd / (u[n - 1]! || du), tau: 0.05 * n * dt, theta: 0, c: 0 };
}

function blockMean(a: Float64Array, f: number): Float64Array {
  const m = Math.floor(a.length / f);
  const out = new Float64Array(m);
  for (let i = 0; i < m; i++) {
    let s = 0;
    for (let k = 0; k < f; k++) s += a[i * f + k]!;
    out[i] = s / f;
  }
  return out;
}

function variance(a: Vec): number {
  const m = mean(a);
  let s = 0;
  let n = 0;
  for (let i = 0; i < a.length; i++) {
    const v = a[i]!;
    if (!Number.isFinite(v)) continue;
    s += (v - m) ** 2;
    n++;
  }
  return n ? s / n : NaN;
}

/** ARX scan: y[k+1] = a·y[k] + b·u[k−d] + c (integrating: on Δy). Returns the best start point. */
function arxStart(u: Float64Array, y: Float64Array, dt: number, kind: ProcessModel['kind'], maxD: number): ProcessModel | null {
  const n = u.length;
  // Integrating: work on the velocity Δy/dt (smoothed lightly by the 2-sample difference).
  const z = kind === 'fopdt' ? y : diffOf(y, dt);
  let best: { sse: number; m: ProcessModel } | null = null;
  const dStep = Math.max(1, Math.floor(maxD / 60));
  for (let d = 0; d <= maxD; d += dStep) {
    const from = d + 1;
    if (n - from < 8) break;
    const beta = leastSquares(n - from - 1, 3, (i, row) => {
      const k = i + from;
      row[0] = z[k]!;
      row[1] = u[k - d]!;
      row[2] = 1;
      return z[k + 1]!;
    });
    const a = beta[0]!;
    const b = beta[1]!;
    const c = beta[2]!;
    if (!Number.isFinite(a) || !(a > 0 && a < 1) || b === 0) continue;
    let sse = 0;
    for (let k = from; k < n - 1; k++) {
      const e = z[k + 1]! - (a * z[k]! + b * u[k - d]! + c);
      sse += e * e;
    }
    const m: ProcessModel = { kind, K: b / (1 - a), tau: -dt / Math.log(a), theta: d * dt, c: c / (1 - a) };
    if (!best || sse < best.sse) best = { sse, m };
  }
  if (best) return best.m;
  // Fallback: static gain from the ends of the record.
  const du = u[n - 1]! - u[0]!;
  if (du === 0) return null;
  const dz = kind === 'fopdt' ? y[n - 1]! - y[0]! : (y[n - 1]! - y[Math.floor(n / 2)]!) / ((n - 1 - Math.floor(n / 2)) * dt);
  return { kind, K: dz / du, tau: n * dt * 0.2, theta: 0, c: 0 };
}

function diffOf(y: Float64Array, dt: number): Float64Array {
  const n = y.length;
  const out = new Float64Array(n);
  for (let k = 1; k < n - 1; k++) out[k] = (y[k + 1]! - y[k - 1]!) / (2 * dt);
  out[0] = out[1] ?? 0;
  out[n - 1] = out[n - 2] ?? 0;
  return out;
}

/** Quick classical estimate from a clean open-loop step (two-point method, Smith). */
export function twoPointFopdt(t: Vec, u: Vec, y: Vec, stepIndex: number): ProcessModel | null {
  const n = y.length;
  if (stepIndex <= 0 || stepIndex >= n - 5) return null;
  const y0 = mean(y, Math.max(0, stepIndex - 20), stepIndex);
  const yEnd = mean(y, Math.floor(n - (n - stepIndex) * 0.1), n);
  const u0 = mean(u, Math.max(0, stepIndex - 20), stepIndex);
  const u1 = mean(u, Math.floor(n - (n - stepIndex) * 0.1), n);
  const du = u1 - u0;
  const dy = yEnd - y0;
  if (du === 0 || dy === 0) return null;
  const ts = t[stepIndex]!;
  let t28 = NaN;
  let t63 = NaN;
  for (let i = stepIndex; i < n; i++) {
    const f = (y[i]! - y0) / dy;
    if (Number.isNaN(t28) && f >= 0.283) t28 = t[i]! - ts;
    if (Number.isNaN(t63) && f >= 0.632) {
      t63 = t[i]! - ts;
      break;
    }
  }
  if (!Number.isFinite(t28) || !Number.isFinite(t63)) return null;
  const tau = 1.5 * (t63 - t28);
  return { kind: 'fopdt', K: dy / du, tau, theta: Math.max(0, t63 - tau), c: y0 - (dy / du) * u0 };
}
