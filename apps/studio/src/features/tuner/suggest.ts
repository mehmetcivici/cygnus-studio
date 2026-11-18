import type { GainRole } from '@cygnus/protocol';
import { gainParam, type LoopContext } from './loop';
import type { Gains, TunerRun } from './types';
import { signalDuration, signalValue, type SignalConfig } from './signals';
import { predictClosedLoop, type Prediction } from './analysis/predict';
import { simcPid, type Aggressiveness } from './analysis/tuning';
import { relayTuning, type RelayRule } from './analysis/relay';
import { detectSteps, stepMetrics, type StepMetrics } from './analysis/step';
import type { ProcessModel } from './analysis/model';

/** Reference test the predictions are drawn for: the last step run of the loop, else the generator. */
export interface Reference {
  t: number[];
  target: number[];
  /** Measured response of that run (absent when taken from the generator). */
  measured?: number[];
  run?: TunerRun;
  stepSize: number;
}

export function referenceProfile(runs: readonly TunerRun[], signal: SignalConfig, y0: number): Reference {
  for (let i = runs.length - 1; i >= 0; i--) {
    const r = runs[i]!;
    if (r.kind === 'closed' && r.analysis.steps.length && r.signal?.kind !== 'chirp') {
      const m = r.analysis.steps[0]!;
      return { t: r.data.t, target: r.data.target, measured: r.data.measured, run: r, stepSize: Math.abs(m.to - m.from) };
    }
  }
  const step: SignalConfig = signal.kind === 'step' ? signal : { ...signal, kind: 'step', from: y0, to: y0 + (signal.to - signal.from || 1) };
  const T = Math.min(10, signalDuration(step));
  const n = Math.max(2, Math.round(T / 0.002));
  const t: number[] = [];
  const target: number[] = [];
  for (let i = 0; i < n; i++) {
    const ti = (T * i) / (n - 1);
    t.push(ti);
    target.push(signalValue(step, ti));
  }
  return { t, target, stepSize: Math.abs(step.to - step.from) };
}

export interface PredictedCurve {
  prediction: Prediction;
  metrics: StepMetrics | null;
}

export function predictCurve(model: ProcessModel, gains: Gains, ref: Reference, opts: { outputLimit?: number; slew?: number }): PredictedCurve {
  const y0 = ref.measured?.[0] ?? ref.target[0] ?? 0;
  const prediction = predictClosedLoop(model, gains, ref.t, ref.target, { outputLimit: opts.outputLimit, slew: opts.slew, y0 });
  const e = detectSteps(prediction.t, prediction.target);
  const metrics = e[0] ? stepMetrics(prediction.t, prediction.target, prediction.y, e[0]) : null;
  return { prediction, metrics };
}

export interface Clamped {
  gains: Gains;
  /** Roles whose suggested value fell outside the parameter range. */
  clamped: GainRole[];
}

/** Clamps suggested gains to the catalog ranges; roles absent from the loop are dropped. */
export function clampGains(ctx: LoopContext, g: Gains): Clamped {
  const out: Gains = {};
  const clamped: GainRole[] = [];
  for (const [role, v] of Object.entries(g) as Array<[GainRole, number]>) {
    const p = gainParam(ctx, role);
    if (!p || !Number.isFinite(v)) continue;
    const c = Math.min(p.max, Math.max(p.min, v));
    if (Math.abs(c - v) > 1e-12 * Math.max(1, Math.abs(v))) clamped.push(role);
    out[role] = Number(c.toPrecision(4));
  }
  return { gains: out, clamped };
}

export function simcSuggestion(ctx: LoopContext, model: ProcessModel, a: Aggressiveness, current: Gains, ref: Reference, outputLimit?: number): Clamped {
  const pid = simcPid(model, a, { stepSize: ref.stepSize, outputLimit });
  const g: Gains = { kp: pid.kp, ki: pid.ki };
  // PI rules for a lag give no derivative; leave an existing Kd alone only when SIMC asks for one.
  if (ctx.roles.includes('kd')) g.kd = pid.kd;
  // With feed-forward doing the heavy lifting the integrator only trims the model error (a few
  // per cent); a tight clamp keeps current-limited steps from winding it up.
  const ffAt = Math.abs(current.kS ?? 0) + Math.abs(current.kV ?? 0) * ref.stepSize;
  if (ctx.roles.includes('iMax') && ffAt > 0) g.iMax = Math.max(0.05, 0.08 * ffAt);
  return clampGains(ctx, g);
}

export function relaySuggestion(ctx: LoopContext, ku: number, tu: number, rule: RelayRule): Clamped {
  const pid = relayTuning(ku, tu, rule);
  const g: Gains = { kp: pid.kp, ki: pid.ki };
  if (ctx.roles.includes('kd')) g.kd = pid.kd;
  return clampGains(ctx, g);
}

export function ffSuggestion(ctx: LoopContext, ff: { kS: number; kV: number; kA: number }): Clamped {
  // Negative friction or inertia terms are fit noise; the boards expect non-negative values.
  return clampGains(ctx, { kS: Math.max(0, ff.kS), kV: Math.max(0, ff.kV), kA: Math.max(0, ff.kA) });
}

/** Output the board can apply: the loop's output limit, capped by what the runs saw. */
export function availableOutput(ctx: LoopContext, gains: Gains, runs: readonly TunerRun[]): number | undefined {
  let opo: number | undefined;
  for (let i = runs.length - 1; i >= 0 && opo === undefined; i--) opo = runs[i]!.analysis.outputPerOpen;
  const lim = opo !== undefined && ctx.openMode ? opo * ctx.openMode.max : undefined;
  const om = gains.outMax !== undefined && gains.outMax > 0 ? gains.outMax : undefined;
  if (lim !== undefined && om !== undefined) return Math.min(lim, om);
  return lim ?? om;
}

export function latestSlew(runs: readonly TunerRun[]): number | undefined {
  for (let i = runs.length - 1; i >= 0; i--) {
    const r = runs[i]!;
    if (r.kind === 'closed' && r.analysis.steps.length) return r.analysis.slew;
  }
  return undefined;
}
