import type { ProcessModel } from './model';

/** Parallel PID as the boards run it: u = kp·e + ki·∫e + kd·de/dt (+ feed-forward). */
export interface Pid {
  kp: number;
  ki: number;
  kd: number;
}

export type Aggressiveness = 'soft' | 'balanced' | 'aggressive';

/** What the suggestion may assume about the test it will be judged on. */
export interface TuneContext {
  /** Size of the reference step (measured units). */
  stepSize?: number;
  /** Output the board can actually apply (e.g. supply voltage), absolute. */
  outputLimit?: number;
}

/**
 * Desired closed-loop time constant τc. SIMC recommends τc = θ for tight control; boards with
 * almost no dead time would then get absurd gains, so two floors apply:
 * - a share of the process speed (τ for a lag, θ otherwise);
 * - the proportional kick for the reference step must fit the available output
 *   (Kc·Δr ≤ share·uLim), which keeps the response out of saturation and windup.
 * Softer settings trade speed for robustness and less noise.
 */
export function closedLoopTau(m: ProcessModel, a: Aggressiveness, c: TuneContext = {}): number {
  const mult = a === 'aggressive' ? 1 : a === 'balanced' ? 2 : 4;
  const frac = a === 'aggressive' ? 0.05 : a === 'balanced' ? 0.1 : 0.2;
  const share = a === 'aggressive' ? 1.5 : a === 'balanced' ? 1 : 0.6;
  const dominant = m.kind === 'fopdt' ? m.tau : Math.max(m.tau, m.theta);
  let sat = 0;
  const K = Math.abs(m.K);
  if (c.stepSize && c.outputLimit && K > 0) {
    const kick = Math.abs(c.stepSize) / (K * share * Math.abs(c.outputLimit));
    sat = (m.kind === 'fopdt' ? m.tau * kick : kick) - m.theta;
  }
  return Math.max(mult * m.theta, frac * dominant, sat, 1e-4);
}

/**
 * SIMC rules (Skogestad 2003).
 * - Self-regulating FOPDT: PI with Kc = τ / (K (τc + θ)), τI = min(τ, 4(τc + θ)).
 * - Integrating (+ lag τ2): series PID with Kc = 1 / (K (τc + θ)), τI = 4(τc + θ), τD = τ2,
 *   converted to the parallel form the boards use.
 */
export function simcPid(m: ProcessModel, a: Aggressiveness, c: TuneContext = {}, tauC = closedLoopTau(m, a, c)): Pid {
  const K = m.K;
  if (!Number.isFinite(K) || K === 0) return { kp: 0, ki: 0, kd: 0 };
  if (m.kind === 'fopdt') {
    const kc = m.tau / (K * (tauC + m.theta));
    const ti = Math.min(m.tau, 4 * (tauC + m.theta));
    return { kp: kc, ki: kc / ti, kd: 0 };
  }
  const kc = 1 / (K * (tauC + m.theta));
  const ti = 4 * (tauC + m.theta);
  const td = m.tau;
  return seriesToParallel(kc, ti, td);
}

/** Series (interacting) PID → parallel gains. */
export function seriesToParallel(kc: number, ti: number, td: number): Pid {
  const f = 1 + td / ti;
  return { kp: kc * f, ki: kc / ti, kd: kc * td };
}

/** Ideal-form (Kc, Ti, Td) → parallel gains. */
export function idealToParallel(kc: number, ti: number, td: number): Pid {
  return { kp: kc, ki: Number.isFinite(ti) && ti > 0 ? kc / ti : 0, kd: kc * td };
}
