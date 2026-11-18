import { clamp, derivative, resample, smooth, type Vec } from './numeric';
import type { ProcessModel } from './model';

/** Gains as the catalog names their roles (all optional; missing = 0 / unlimited). */
export interface LoopGains {
  kp?: number;
  ki?: number;
  kd?: number;
  kS?: number;
  kV?: number;
  kA?: number;
  iMax?: number;
  outMax?: number;
}

export interface PredictOptions {
  /** Simulation step, s (default 1 ms, the boards' loop rate). */
  dt?: number;
  /** Absolute output limit applied after the controller (e.g. supply voltage). */
  outputLimit?: number;
  /** Measurement starts here (default: the first target value). */
  y0?: number;
  /**
   * Largest rate of change of the measurement, units/s. Boards limit current, which shows up
   * as an acceleration (fopdt) or speed (integrating) ceiling that a linear model lacks.
   */
  slew?: number;
}

export interface Prediction {
  t: Float64Array;
  target: Float64Array;
  y: Float64Array;
  u: Float64Array;
}

/**
 * Closed-loop prediction: the identified model driven by the board's controller structure
 * (parallel PID with integral clamp, derivative on error, feed-forward kS·sgn(r) + kV·r + kA·ṙ,
 * output clamp). The target profile is resampled to the simulation step.
 */
export function predictClosedLoop(model: ProcessModel, gains: LoopGains, tIn: Vec, targetIn: Vec, o: PredictOptions = {}): Prediction {
  const dt = o.dt ?? 0.001;
  const n0 = tIn.length;
  const t0 = n0 ? tIn[0]! : 0;
  const span = n0 ? tIn[n0 - 1]! - t0 : 0;
  const n = Math.max(2, Math.min(200_000, Math.floor(span / dt) + 1));
  const t = new Float64Array(n);
  const r = new Float64Array(n);
  let j = 0;
  for (let k = 0; k < n; k++) {
    const tk = t0 + k * dt;
    while (j < n0 - 1 && tIn[j + 1]! <= tk) j++;
    t[k] = tk - t0;
    r[k] = targetIn[j]!;
  }
  const kp = gains.kp ?? 0;
  const ki = gains.ki ?? 0;
  const kd = gains.kd ?? 0;
  const kS = gains.kS ?? 0;
  const kV = gains.kV ?? 0;
  const kA = gains.kA ?? 0;
  const iMax = gains.iMax !== undefined && gains.iMax > 0 ? gains.iMax : Infinity;
  const outMax = Math.min(gains.outMax !== undefined && gains.outMax > 0 ? gains.outMax : Infinity, o.outputLimit ?? Infinity);
  const y = new Float64Array(n);
  const u = new Float64Array(n);
  const delay = Math.max(0, model.theta / dt);
  const d0 = Math.floor(delay);
  const fr = delay - d0;
  const tau = Math.max(0, model.tau);
  const a = tau > 0 ? Math.exp(-dt / tau) : 0;
  let yk = o.y0 ?? r[0]!;
  let v = 0;
  let integ = 0;
  let prevErr = r[0]! - yk;
  let prevR = r[0]!;
  // Start at equilibrium: for the self-regulating model the integrator holds the load.
  if (model.kind === 'fopdt' && model.K !== 0) {
    const uEq = (yk - model.c) / model.K;
    const ff0 = (r[0]! > 0 ? kS : r[0]! < 0 ? -kS : 0) + kV * r[0]!;
    integ = ki > 0 ? clamp(uEq - ff0, -iMax, iMax) : 0;
  } else if (model.kind === 'integrating' && model.K !== 0 && ki > 0) {
    integ = clamp(-model.c / model.K, -iMax, iMax);
  }
  for (let k = 0; k < n; k++) {
    y[k] = yk;
    const rk = r[k]!;
    const err = rk - yk;
    integ = clamp(integ + ki * err * dt, -iMax, iMax);
    const der = k === 0 ? 0 : (kd * (err - prevErr)) / dt;
    prevErr = err;
    const acc = k === 0 ? 0 : (rk - prevR) / dt;
    prevR = rk;
    const ff = (rk > 0 ? kS : rk < 0 ? -kS : 0) + kV * rk + kA * acc;
    u[k] = clamp(kp * err + integ + der + ff, -outMax, outMax);
    // Delayed input with fractional interpolation.
    const ia = k - d0;
    const ua = ia >= 0 ? u[ia]! : u[0]!;
    const ub = ia - 1 >= 0 ? u[ia - 1]! : u[0]!;
    const ud = ua * (1 - fr) + ub * fr;
    const drive = model.K * ud + model.c;
    const slew = o.slew !== undefined && o.slew > 0 ? o.slew * dt : Infinity;
    if (model.kind === 'fopdt') yk += clamp((1 - a) * (drive - yk), -slew, slew);
    else {
      const vNext = clamp(a * v + (1 - a) * drive, -slew / dt, slew / dt);
      yk += 0.5 * (v + vNext) * dt;
      v = vNext;
    }
  }
  return { t, target: r, y, u };
}

/**
 * Rate ceiling seen in a record: the 98th percentile of |dy/dt| (smoothed over ~10 ms). Used
 * as the prediction's slew limit when a run showed saturation.
 */
export function slewFromRecord(t: Vec, y: Vec): number {
  const r = resample(t, [y]);
  const ys = smooth(r.ch[0]!, 0.01, r.dt);
  const d = derivative(ys, r.dt, Math.max(1, Math.round(0.005 / r.dt)));
  const abs = Array.from(d, Math.abs).sort((a, b) => a - b);
  return abs[Math.floor(abs.length * 0.98)] ?? NaN;
}
