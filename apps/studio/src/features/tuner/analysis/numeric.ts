// Small numeric toolkit for the tuner analyses. Arrays are plain number arrays or typed arrays;
// every function is pure and allocation-light enough for 20k-sample records.

export type Vec = ArrayLike<number>;

export function mean(a: Vec, from = 0, to = a.length): number {
  let s = 0;
  let n = 0;
  for (let i = from; i < to; i++) {
    const v = a[i]!;
    if (Number.isFinite(v)) {
      s += v;
      n++;
    }
  }
  return n ? s / n : NaN;
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Linear interpolation of (xs, ys) at x; xs ascending. Clamps outside the range. */
export function interp(xs: Vec, ys: Vec, x: number): number {
  const n = xs.length;
  if (n === 0) return NaN;
  if (x <= xs[0]!) return ys[0]!;
  if (x >= xs[n - 1]!) return ys[n - 1]!;
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >>> 1;
    if (xs[mid]! <= x) lo = mid;
    else hi = mid;
  }
  const x0 = xs[lo]!;
  const x1 = xs[hi]!;
  const f = x1 > x0 ? (x - x0) / (x1 - x0) : 0;
  return ys[lo]! + f * (ys[hi]! - ys[lo]!);
}

export interface Uniform {
  /** Sample period, s. */
  dt: number;
  t0: number;
  /** One array per input channel, all of the same length. */
  ch: Float64Array[];
}

/**
 * Resamples irregular records onto a uniform grid (linear interpolation; NaN samples are
 * skipped). Stream records are nearly uniform already, but lost frames leave gaps.
 */
export function resample(t: Vec, channels: readonly Vec[], dt?: number): Uniform {
  const n = t.length;
  if (n < 2) return { dt: dt ?? 0.001, t0: n ? t[0]! : 0, ch: channels.map(() => new Float64Array(0)) };
  const t0 = t[0]!;
  const span = t[n - 1]! - t0;
  const step = dt ?? medianStep(t);
  const m = Math.max(2, Math.floor(span / step) + 1);
  const ch = channels.map((ys) => {
    // Drop NaNs for interpolation.
    const xs: number[] = [];
    const vs: number[] = [];
    for (let i = 0; i < n; i++) {
      const v = ys[i]!;
      if (Number.isFinite(v)) {
        xs.push(t[i]!);
        vs.push(v);
      }
    }
    const out = new Float64Array(m);
    let j = 0;
    for (let k = 0; k < m; k++) {
      const x = t0 + k * step;
      while (j < xs.length - 2 && xs[j + 1]! <= x) j++;
      if (xs.length === 0) out[k] = NaN;
      else if (xs.length === 1) out[k] = vs[0]!;
      else {
        const xa = xs[j]!;
        const xb = xs[j + 1]!;
        const f = xb > xa ? clamp((x - xa) / (xb - xa), 0, 1) : 0;
        out[k] = vs[j]! + f * (vs[j + 1]! - vs[j]!);
      }
    }
    return out;
  });
  return { dt: step, t0, ch };
}

export function medianStep(t: Vec): number {
  const n = t.length;
  if (n < 2) return 0.001;
  const d: number[] = [];
  const stride = Math.max(1, Math.floor(n / 512));
  for (let i = stride; i < n; i += stride) d.push((t[i]! - t[i - stride]!) / stride);
  d.sort((a, b) => a - b);
  const m = d[d.length >> 1] ?? 0.001;
  return m > 0 ? m : 0.001;
}

/**
 * Least squares `X·β ≈ y` through the normal equations with a tiny ridge for conditioning.
 * `rows(i, out)` fills row i of X. Returns β (NaN when singular).
 */
export function leastSquares(nRows: number, nCols: number, rows: (i: number, out: Float64Array) => number, ridge = 1e-12): Float64Array {
  const A = new Float64Array(nCols * nCols);
  const b = new Float64Array(nCols);
  const r = new Float64Array(nCols);
  for (let i = 0; i < nRows; i++) {
    const y = rows(i, r);
    if (!Number.isFinite(y)) continue;
    let ok = true;
    for (let p = 0; p < nCols; p++) if (!Number.isFinite(r[p]!)) ok = false;
    if (!ok) continue;
    for (let p = 0; p < nCols; p++) {
      const rp = r[p]!;
      b[p]! += rp * y;
      for (let q = p; q < nCols; q++) A[p * nCols + q]! += rp * r[q]!;
    }
  }
  for (let p = 0; p < nCols; p++) for (let q = 0; q < p; q++) A[p * nCols + q] = A[q * nCols + p]!;
  // Scale-aware ridge.
  for (let p = 0; p < nCols; p++) A[p * nCols + p]! += ridge * (Math.abs(A[p * nCols + p]!) + 1e-300);
  return solve(A, b, nCols);
}

/** Gaussian elimination with partial pivoting; A is n×n row-major (copied). */
export function solve(Ain: Float64Array, bin: Float64Array, n: number): Float64Array {
  const A = Float64Array.from(Ain);
  const b = Float64Array.from(bin);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r * n + c]!) > Math.abs(A[piv * n + c]!)) piv = r;
    if (Math.abs(A[piv * n + c]!) < 1e-300) return new Float64Array(n).fill(NaN);
    if (piv !== c) {
      for (let k = 0; k < n; k++) {
        const tmp = A[c * n + k]!;
        A[c * n + k] = A[piv * n + k]!;
        A[piv * n + k] = tmp;
      }
      const tb = b[c]!;
      b[c] = b[piv]!;
      b[piv] = tb;
    }
    for (let r = c + 1; r < n; r++) {
      const f = A[r * n + c]! / A[c * n + c]!;
      if (f === 0) continue;
      for (let k = c; k < n; k++) A[r * n + k]! -= f * A[c * n + k]!;
      b[r]! -= f * b[c]!;
    }
  }
  const x = new Float64Array(n);
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r]!;
    for (let k = r + 1; k < n; k++) s -= A[r * n + k]! * x[k]!;
    x[r] = s / A[r * n + r]!;
  }
  return x;
}

export interface NelderMeadOptions {
  maxIter?: number;
  /** Initial simplex step per parameter. */
  step?: readonly number[];
  tol?: number;
}

/** Derivative-free minimiser for the small (≤ 5 parameter) model fits. */
export function nelderMead(f: (x: Float64Array) => number, x0: readonly number[], o: NelderMeadOptions = {}): { x: Float64Array; fx: number } {
  const n = x0.length;
  const maxIter = o.maxIter ?? 400 * n;
  const tol = o.tol ?? 1e-10;
  const pts: Float64Array[] = [Float64Array.from(x0)];
  for (let i = 0; i < n; i++) {
    const p = Float64Array.from(x0);
    const s = o.step?.[i] ?? (Math.abs(x0[i]!) > 1e-12 ? 0.1 * Math.abs(x0[i]!) : 0.05);
    p[i]! += s;
    pts.push(p);
  }
  const val = pts.map((p) => safe(f(p)));
  const centroid = new Float64Array(n);
  const tryPt = (a: Float64Array, b: Float64Array, k: number): Float64Array => {
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) out[i] = a[i]! + k * (b[i]! - a[i]!);
    return out;
  };
  for (let it = 0; it < maxIter; it++) {
    const order = val.map((_, i) => i).sort((a, b) => val[a]! - val[b]!);
    const sortedP = order.map((i) => pts[i]!);
    const sortedV = order.map((i) => val[i]!);
    for (let i = 0; i <= n; i++) {
      pts[i] = sortedP[i]!;
      val[i] = sortedV[i]!;
    }
    if (Math.abs(val[n]! - val[0]!) <= tol * (Math.abs(val[0]!) + tol)) break;
    centroid.fill(0);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) centroid[j]! += pts[i]![j]! / n;
    const worst = pts[n]!;
    const xr = tryPt(centroid, worst, -1);
    const fr = safe(f(xr));
    if (fr < val[0]!) {
      const xe = tryPt(centroid, worst, -2);
      const fe = safe(f(xe));
      if (fe < fr) {
        pts[n] = xe;
        val[n] = fe;
      } else {
        pts[n] = xr;
        val[n] = fr;
      }
    } else if (fr < val[n - 1]!) {
      pts[n] = xr;
      val[n] = fr;
    } else {
      const outside = fr < val[n]!;
      const xc = outside ? tryPt(centroid, worst, -0.5) : tryPt(centroid, worst, 0.5);
      const fc = safe(f(xc));
      if (fc < Math.min(fr, val[n]!)) {
        pts[n] = xc;
        val[n] = fc;
      } else {
        for (let i = 1; i <= n; i++) {
          pts[i] = tryPt(pts[0]!, pts[i]!, 0.5);
          val[i] = safe(f(pts[i]!));
        }
      }
    }
  }
  let best = 0;
  for (let i = 1; i <= n; i++) if (val[i]! < val[best]!) best = i;
  return { x: pts[best]!, fx: val[best]! };
}

function safe(v: number): number {
  return Number.isFinite(v) ? v : 1e300;
}

/** One-pole low-pass, zero phase (forward + backward) so edges are not delayed. */
export function smooth(a: Vec, tau: number, dt: number): Float64Array {
  const n = a.length;
  const out = new Float64Array(n);
  if (!n) return out;
  const k = tau > 0 ? 1 - Math.exp(-dt / tau) : 1;
  let s = a[0]!;
  for (let i = 0; i < n; i++) {
    s += k * (a[i]! - s);
    out[i] = s;
  }
  s = out[n - 1]!;
  for (let i = n - 1; i >= 0; i--) {
    s += k * (out[i]! - s);
    out[i] = s;
  }
  return out;
}

/** Central-difference derivative of a uniform series. */
export function derivative(a: Vec, dt: number, half = 1): Float64Array {
  const n = a.length;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - half);
    const hi = Math.min(n - 1, i + half);
    out[i] = hi > lo ? (a[hi]! - a[lo]!) / ((hi - lo) * dt) : 0;
  }
  return out;
}

/** RMS of a series after removing its least-squares line. */
export function detrendedRms(t: Vec, y: Vec, from = 0, to = y.length): number {
  const n = to - from;
  if (n < 3) return NaN;
  let st = 0;
  let sy = 0;
  let stt = 0;
  let sty = 0;
  let m = 0;
  for (let i = from; i < to; i++) {
    const ti = t[i]!;
    const yi = y[i]!;
    if (!Number.isFinite(yi)) continue;
    st += ti;
    sy += yi;
    stt += ti * ti;
    sty += ti * yi;
    m++;
  }
  if (m < 3) return NaN;
  const den = m * stt - st * st;
  const b = den !== 0 ? (m * sty - st * sy) / den : 0;
  const a = (sy - b * st) / m;
  let ss = 0;
  for (let i = from; i < to; i++) {
    const yi = y[i]!;
    if (!Number.isFinite(yi)) continue;
    const r = yi - (a + b * t[i]!);
    ss += r * r;
  }
  return Math.sqrt(ss / m);
}

/** Deterministic Gaussian noise for tests and synthetic data (xorshift + Box–Muller). */
export function noiseSource(seed = 1): () => number {
  let s = seed >>> 0 || 1;
  const u = (): number => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return (s + 0.5) / 4294967296;
  };
  return () => Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u());
}

/** Unwraps a phase series in degrees. */
export function unwrapDeg(p: Vec): Float64Array {
  const out = Float64Array.from(p);
  for (let i = 1; i < out.length; i++) {
    let d = out[i]! - out[i - 1]!;
    while (d > 180) {
      out[i]! -= 360;
      d -= 360;
    }
    while (d < -180) {
      out[i]! += 360;
      d += 360;
    }
  }
  return out;
}
