// Test signal generator: pure functions of time so the same profile can be previewed, checked
// against the test limits before anything is sent, and replayed by the predictor.

export type SignalKind = 'manual' | 'step' | 'square' | 'sine' | 'trapezoid' | 'chirp';

export const SIGNAL_KINDS: readonly SignalKind[] = ['manual', 'step', 'square', 'sine', 'trapezoid', 'chirp'];

export interface SignalConfig {
  kind: SignalKind;
  /** Step / trapezoid: start (A) and end (B) levels. */
  from: number;
  to: number;
  /** Lead-in at the start level before the first change, s. */
  pre: number;
  /** Time spent at each level, s. */
  hold: number;
  /** Square / sine / chirp: centre and amplitude. */
  offset: number;
  amplitude: number;
  /** Square period, s. */
  period: number;
  /** Sine frequency, Hz. */
  freq: number;
  /** Trapezoid ramp time, s. */
  ramp: number;
  /** Chirp start/end frequency, Hz, and sweep time, s. */
  f0: number;
  f1: number;
  sweep: number;
  /** Repetitions of the pattern (cycles for square / sine). */
  repeats: number;
}

export function defaultSignal(kind: SignalKind, span: number, centre = 0): SignalConfig {
  return {
    kind,
    from: centre,
    to: centre + span,
    pre: 0.3,
    hold: 1,
    offset: centre + span / 2,
    amplitude: span / 2,
    period: 1,
    freq: 1,
    ramp: 0.5,
    f0: 0.5,
    f1: 20,
    sweep: 15,
    repeats: 1,
  };
}

const reps = (c: SignalConfig): number => Math.max(1, Math.min(50, Math.round(c.repeats)));

/** Total length of the profile, s (Infinity for manual). */
export function signalDuration(c: SignalConfig): number {
  const pre = Math.max(0, c.pre);
  switch (c.kind) {
    case 'manual':
      return Infinity;
    case 'step':
      return pre + reps(c) * 2 * Math.max(0.01, c.hold);
    case 'square':
      return pre + reps(c) * Math.max(0.01, c.period);
    case 'sine':
      return pre + reps(c) / Math.max(1e-3, c.freq);
    case 'trapezoid':
      return pre + reps(c) * 2 * (Math.max(0.001, c.ramp) + Math.max(0, c.hold));
    case 'chirp':
      return pre + reps(c) * Math.max(0.5, c.sweep);
  }
}

/** Logarithmic chirp f0 → f1 over T (phase-continuous), amplitude `a`, starting at 0. */
export function chirpValue(t: number, T: number, f0: number, f1: number, a: number): number {
  if (t <= 0) return 0;
  const tt = Math.min(t, T);
  const k = f1 / f0;
  const phase = Math.abs(k - 1) < 1e-9 ? 2 * Math.PI * f0 * tt : ((2 * Math.PI * f0 * T) / Math.log(k)) * (k ** (tt / T) - 1);
  return a * Math.sin(phase);
}

/** Instantaneous chirp frequency at t, Hz. */
export function chirpFrequency(t: number, T: number, f0: number, f1: number): number {
  return f0 * (f1 / f0) ** (Math.min(Math.max(t, 0), T) / T);
}

/** Target at time t (s) since the start of the test. Manual returns `from`. */
export function signalValue(c: SignalConfig, t: number): number {
  const pre = Math.max(0, c.pre);
  if (c.kind === 'manual') return c.from;
  if (t < pre) {
    if (c.kind === 'step' || c.kind === 'trapezoid') return c.from;
    return c.offset;
  }
  const s = Math.min(t, signalDuration(c)) - pre;
  switch (c.kind) {
    case 'step': {
      const h = Math.max(0.01, c.hold);
      const k = Math.floor(s / h);
      return k % 2 === 0 && s < reps(c) * 2 * h ? c.to : c.from;
    }
    case 'square': {
      const p = Math.max(0.01, c.period);
      const ph = (s % p) / p;
      if (s >= reps(c) * p) return c.offset;
      return ph < 0.5 ? c.offset + c.amplitude : c.offset - c.amplitude;
    }
    case 'sine': {
      if (s >= reps(c) / Math.max(1e-3, c.freq)) return c.offset;
      return c.offset + c.amplitude * Math.sin(2 * Math.PI * c.freq * s);
    }
    case 'trapezoid': {
      const r = Math.max(0.001, c.ramp);
      const h = Math.max(0, c.hold);
      const cyc = 2 * (r + h);
      if (s >= reps(c) * cyc) return c.from;
      const p = s % cyc;
      const d = c.to - c.from;
      if (p < r) return c.from + (d * p) / r;
      if (p < r + h) return c.to;
      if (p < 2 * r + h) return c.to - (d * (p - r - h)) / r;
      return c.from;
    }
    case 'chirp': {
      const T = Math.max(0.5, c.sweep);
      if (s >= reps(c) * T) return c.offset;
      return c.offset + chirpValue(s % T, T, Math.max(1e-3, c.f0), Math.max(1e-3, c.f1), c.amplitude);
    }
  }
}

/** Smallest and largest target the profile will request. */
export function signalExtent(c: SignalConfig): [number, number] {
  switch (c.kind) {
    case 'manual':
      return [c.from, c.from];
    case 'step':
    case 'trapezoid':
      return [Math.min(c.from, c.to), Math.max(c.from, c.to)];
    case 'square':
    case 'sine':
    case 'chirp': {
      const a = Math.abs(c.amplitude);
      return [c.offset - a, c.offset + a];
    }
  }
}

/** Samples the profile for previews (n points over the whole duration). */
export function sampleSignal(c: SignalConfig, n = 200): { t: number[]; v: number[] } {
  const T = signalDuration(c);
  const span = Number.isFinite(T) ? T : 1;
  const t: number[] = [];
  const v: number[] = [];
  for (let i = 0; i < n; i++) {
    const ti = (span * i) / (n - 1);
    t.push(ti);
    v.push(signalValue(c, ti));
  }
  return { t, v };
}
