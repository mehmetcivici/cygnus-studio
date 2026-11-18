import { resample, unwrapDeg, type Vec } from './numeric';
import type { LoopGains } from './predict';
import type { ProcessModel } from './model';

/** Complex frequency response sampled at `f` (Hz). */
export interface FreqResponse {
  f: Float64Array;
  re: Float64Array;
  im: Float64Array;
  /** Coherence-like quality per point, 0..1 (share of output energy explained). */
  quality?: Float64Array;
}

export interface BodeData {
  f: Float64Array;
  magDb: Float64Array;
  phaseDeg: Float64Array;
}

export interface Margins {
  /** Gain margin, dB (Infinity when the phase never reaches −180°). */
  gainMarginDb: number;
  /** Frequency where the phase crosses −180°, Hz. */
  phaseCrossHz: number;
  /** Phase margin, degrees (NaN when |L| never crosses 1). */
  phaseMarginDeg: number;
  /** Gain crossover frequency (|L| = 1), Hz. */
  gainCrossHz: number;
}

/** In-place iterative radix-2 FFT. */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let tmp = re[i]!;
      re[i] = re[j]!;
      re[j] = tmp;
      tmp = im[i]!;
      im[i] = im[j]!;
      im[j] = tmp;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const xr = re[b]! * cr - im[b]! * ci;
        const xi = re[b]! * ci + im[b]! * cr;
        re[b] = re[a]! - xr;
        im[b] = im[a]! - xi;
        re[a]! += xr;
        im[a]! += xi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

function detrend(a: Float64Array): Float64Array {
  const n = a.length;
  let st = 0;
  let sy = 0;
  let stt = 0;
  let sty = 0;
  for (let i = 0; i < n; i++) {
    st += i;
    sy += a[i]!;
    stt += i * i;
    sty += i * a[i]!;
  }
  const den = n * stt - st * st;
  const b = den ? (n * sty - st * sy) / den : 0;
  const c = (sy - b * st) / n;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = a[i]! - (c + b * i);
  return out;
}

/**
 * Empirical transfer function y/u from a sweep record: whole-record FFTs, then the H1
 * estimate Σ Y·U* / Σ |U|² inside log-spaced bands between f0 and f1. Bands where the input
 * carries little energy are dropped.
 */
export function estimateResponse(t: Vec, u: Vec, y: Vec, f0: number, f1: number, bands = 40): FreqResponse {
  const r = resample(t, [u, y]);
  const dt = r.dt;
  const ua = detrend(r.ch[0]!);
  const ya = detrend(r.ch[1]!);
  const n = ua.length;
  let N = 1;
  while (N < n) N <<= 1;
  const ur = new Float64Array(N);
  const ui = new Float64Array(N);
  const yr = new Float64Array(N);
  const yi = new Float64Array(N);
  ur.set(ua);
  yr.set(ya);
  fft(ur, ui);
  fft(yr, yi);
  const df = 1 / (N * dt);
  const fNyq = 0.5 / dt;
  const lo = Math.max(f0, df);
  const hi = Math.min(f1, fNyq * 0.8);
  const fs: number[] = [];
  const res: number[] = [];
  const ims: number[] = [];
  const qs: number[] = [];
  if (!(hi > lo)) return { f: new Float64Array(0), re: new Float64Array(0), im: new Float64Array(0) };
  let maxPow = 0;
  for (let k = 1; k < N / 2; k++) {
    const f = k * df;
    if (f >= lo && f <= hi) maxPow = Math.max(maxPow, ur[k]! ** 2 + ui[k]! ** 2);
  }
  const ratio = hi / lo;
  for (let b = 0; b < bands; b++) {
    const fa = lo * ratio ** (b / bands);
    const fb = lo * ratio ** ((b + 1) / bands);
    const ka = Math.max(1, Math.ceil(fa / df));
    const kb = Math.min(N / 2 - 1, Math.floor(fb / df));
    let sr = 0;
    let si = 0;
    let suu = 0;
    let syy = 0;
    let fsum = 0;
    let cnt = 0;
    for (let k = ka; k <= kb; k++) {
      // Y·conj(U)
      sr += yr[k]! * ur[k]! + yi[k]! * ui[k]!;
      si += yi[k]! * ur[k]! - yr[k]! * ui[k]!;
      const pu = ur[k]! ** 2 + ui[k]! ** 2;
      suu += pu;
      syy += yr[k]! ** 2 + yi[k]! ** 2;
      fsum += k * df * pu;
      cnt++;
    }
    if (!cnt || suu < maxPow * 1e-4 * cnt) continue;
    fs.push(fsum / suu);
    res.push(sr / suu);
    ims.push(si / suu);
    qs.push(syy > 0 ? Math.min(1, (sr * sr + si * si) / (suu * syy)) : 0);
  }
  return { f: Float64Array.from(fs), re: Float64Array.from(res), im: Float64Array.from(ims), quality: Float64Array.from(qs) };
}

/** Controller frequency response C(jω) = kp + ki/(jω) + kd·jω. */
export function pidResponse(g: LoopGains, f: number): [number, number] {
  const w = 2 * Math.PI * f;
  return [g.kp ?? 0, (g.kd ?? 0) * w - (g.ki ?? 0) / w];
}

/** Loop transfer L = P·C at the frequencies of P. */
export function loopResponse(p: FreqResponse, g: LoopGains): FreqResponse {
  const n = p.f.length;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const [cr, ci] = pidResponse(g, p.f[i]!);
    re[i] = p.re[i]! * cr - p.im[i]! * ci;
    im[i] = p.re[i]! * ci + p.im[i]! * cr;
  }
  return { f: Float64Array.from(p.f), re, im, quality: p.quality };
}

/** Model frequency response, for overlaying the identified model on measured points. */
export function modelResponse(m: ProcessModel, fs: Vec): FreqResponse {
  const n = fs.length;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const w = 2 * Math.PI * fs[i]!;
    // K e^{-jωθ} / (1 + jωτ)  [· 1/(jω) for integrating]
    const dr = 1;
    const di = w * m.tau;
    const den = dr * dr + di * di;
    let hr = (m.K * dr) / den;
    let hi = (-m.K * di) / den;
    const cr = Math.cos(-w * m.theta);
    const ci = Math.sin(-w * m.theta);
    const tr = hr * cr - hi * ci;
    hi = hr * ci + hi * cr;
    hr = tr;
    if (m.kind === 'integrating') {
      // multiply by 1/(jω) = −j/ω
      const nr = hi / w;
      const ni = -hr / w;
      hr = nr;
      hi = ni;
    }
    re[i] = hr;
    im[i] = hi;
  }
  return { f: Float64Array.from(fs), re, im };
}

export function toBode(h: FreqResponse): BodeData {
  const n = h.f.length;
  const mag = new Float64Array(n);
  const ph = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    mag[i] = 20 * Math.log10(Math.hypot(h.re[i]!, h.im[i]!) || 1e-300);
    ph[i] = (Math.atan2(h.im[i]!, h.re[i]!) * 180) / Math.PI;
  }
  const un = unwrapDeg(ph);
  // Anchor the unwrapped phase so the first point lies in (−270°, 90°].
  if (n) {
    let off = 0;
    while (un[0]! + off > 90) off -= 360;
    while (un[0]! + off <= -270) off += 360;
    for (let i = 0; i < n; i++) un[i]! += off;
  }
  return { f: Float64Array.from(h.f), magDb: mag, phaseDeg: un };
}

/** Gain and phase margins of a loop response (log-frequency interpolation between points). */
export function margins(b: BodeData): Margins {
  const n = b.f.length;
  let gainCrossHz = NaN;
  let phaseMarginDeg = NaN;
  let phaseCrossHz = NaN;
  let gainMarginDb = Infinity;
  for (let i = 0; i + 1 < n; i++) {
    const m0 = b.magDb[i]!;
    const m1 = b.magDb[i + 1]!;
    if (Number.isNaN(gainCrossHz) && m0 >= 0 && m1 < 0) {
      const s = m0 / (m0 - m1);
      gainCrossHz = logLerp(b.f[i]!, b.f[i + 1]!, s);
      const ph = b.phaseDeg[i]! + s * (b.phaseDeg[i + 1]! - b.phaseDeg[i]!);
      phaseMarginDeg = 180 + ph;
    }
    const p0 = b.phaseDeg[i]! + 180;
    const p1 = b.phaseDeg[i + 1]! + 180;
    if (Number.isNaN(phaseCrossHz) && p0 > 0 && p1 <= 0) {
      const s = p0 / (p0 - p1);
      phaseCrossHz = logLerp(b.f[i]!, b.f[i + 1]!, s);
      gainMarginDb = -(m0 + s * (m1 - m0));
    }
  }
  return { gainMarginDb, phaseCrossHz, phaseMarginDeg, gainCrossHz };
}

function logLerp(a: number, b: number, s: number): number {
  return Math.exp(Math.log(a) + s * (Math.log(b) - Math.log(a)));
}
