import { describe, expect, it } from 'vitest';
import { closedLoopTau, seriesToParallel, simcPid } from './tuning';
import { predictClosedLoop } from './predict';
import { detectSteps, stepMetrics } from './step';
import { analyzeRelay, modelUltimate, relayTuning } from './relay';
import type { ProcessModel } from './model';
import { noiseSource } from './numeric';

const DT = 0.001;


function stepRun(m: ProcessModel, gains: Parameters<typeof predictClosedLoop>[1], A = 100, T = 4) {
  const t = Float64Array.from({ length: Math.round(T / DT) }, (_, i) => i * DT);
  const r = Float64Array.from(t, (x) => (x >= 0.2 ? A : 0));
  const p = predictClosedLoop(m, gains, t, r, { y0: 0 });
  return stepMetrics(p.t, p.target, p.y, detectSteps(p.t, p.target)[0]!);
}

describe('SIMC', () => {
  it('follows the published FOPDT rule', () => {
    const m: ProcessModel = { kind: 'fopdt', K: 2, tau: 10, theta: 1, c: 0 };
    const g = simcPid(m, 'aggressive', {}, 1);
    // Kc = τ / (K (τc + θ)) = 10 / (2·2) = 2.5; τI = min(10, 8) = 8
    expect(g.kp).toBeCloseTo(2.5, 6);
    expect(g.ki).toBeCloseTo(2.5 / 8, 6);
    expect(g.kd).toBe(0);
  });

  it('follows the integrating rule with lag as derivative time', () => {
    const m: ProcessModel = { kind: 'integrating', K: 0.5, tau: 0.2, theta: 0.1, c: 0 };
    const g = simcPid(m, 'aggressive', {}, 0.1);
    const ser = seriesToParallel(1 / (0.5 * 0.2), 0.8, 0.2);
    expect(g.kp).toBeCloseTo(ser.kp, 9);
    expect(g.ki).toBeCloseTo(ser.ki, 9);
    expect(g.kd).toBeCloseTo(ser.kd, 9);
    expect(ser.kp).toBeCloseTo(10 * 1.25, 9);
  });

  it('gives well-damped closed loops, faster when more aggressive', () => {
    const m: ProcessModel = { kind: 'fopdt', K: 400, tau: 0.6, theta: 0.02, c: 0 };
    const soft = stepRun(m, simcPid(m, 'soft'));
    const aggr = stepRun(m, simcPid(m, 'aggressive'));
    expect(aggr.riseTime).toBeLessThan(soft.riseTime);
    expect(soft.overshoot).toBeLessThan(5);
    expect(aggr.overshoot).toBeLessThan(15);
    expect(aggr.steadyErrorPct).toBeLessThan(1);
    expect(closedLoopTau(m, 'balanced')).toBeGreaterThan(closedLoopTau(m, 'aggressive'));
  });

  it('keeps the proportional kick inside the available output', () => {
    const m: ProcessModel = { kind: 'integrating', K: 0.15, tau: 0.05, theta: 0, c: 0 };
    const g = simcPid(m, 'balanced', { stepSize: 0.15, outputLimit: 12 });
    // Series Kc·Δr = 12 V at share 1 (θ = 0): the parallel kp is Kc·(1 + τD/τI).
    const tc = closedLoopTau(m, 'balanced', { stepSize: 0.15, outputLimit: 12 });
    expect(tc).toBeCloseTo(0.15 / (0.15 * 12), 9);
    expect((1 / (0.15 * tc)) * 0.15).toBeCloseTo(12, 6);
    expect(g.kp).toBeGreaterThan(1 / (0.15 * tc));
  });

  it('stabilises an integrating process with lag', () => {
    const m: ProcessModel = { kind: 'integrating', K: 2, tau: 0.1, theta: 0.01, c: 0 };
    const res = stepRun(m, simcPid(m, 'balanced'), 0.2, 6);
    expect(res.steadyErrorPct).toBeLessThan(1);
    expect(res.overshoot).toBeLessThan(40);
    expect(Number.isFinite(res.settlingTime)).toBe(true);
  });
});

/** Relay feedback around r = 0 on a model (host-side relay, sampled every DT). */
function relaySim(m: ProcessModel, d: number, T: number, noise = 0, eps = 0) {
  const n = Math.round(T / DT);
  const t = new Float64Array(n);
  const u = new Float64Array(n);
  const y = new Float64Array(n);
  const delay = Math.round(m.theta / DT);
  const a = m.tau > 0 ? Math.exp(-DT / m.tau) : 0;
  let yk = 0;
  let v = 0;
  const g = noiseSource(9);
  let out = d;
  for (let k = 0; k < n; k++) {
    t[k] = k * DT;
    const meas = yk + noise * g();
    y[k] = meas;
    if (meas > eps) out = -d;
    else if (meas < -eps) out = d;
    u[k] = out;
    const ud = k - delay >= 0 ? u[k - delay]! : 0;
    if (m.kind === 'fopdt') yk = a * yk + (1 - a) * m.K * ud;
    else {
      const vn = a * v + (1 - a) * m.K * ud;
      yk += 0.5 * (v + vn) * DT;
      v = vn;
    }
  }
  return { t, u, y };
}

describe('relay experiment', () => {
  it('integrator + dead time: Tu = 4θ', () => {
    const m: ProcessModel = { kind: 'integrating', K: 2, tau: 0, theta: 0.05, c: 0 };
    const { t, u, y } = relaySim(m, 1, 3);
    const r = analyzeRelay(t, u, y)!;
    expect(r.tu).toBeCloseTo(0.2, 2);
    // Describing function of the triangle wave: 4/(πKθ) vs exact π/(2Kθ) (−19 %).
    expect(r.ku).toBeCloseTo(4 / (Math.PI * 2 * 0.05), 0);
    expect(r.cycles).toBeGreaterThanOrEqual(10);
  });

  it('FOPDT: Ku and Tu near the analytic ultimate point, also with noise', () => {
    const m: ProcessModel = { kind: 'fopdt', K: 1, tau: 0.2, theta: 0.05, c: 0 };
    // Solve −atan(ωτ) − ωθ = −π
    const { ku: kuTrue, tu: tuTrue } = modelUltimate(m)!;
    for (const noise of [0, 0.002]) {
      // Hysteresis of a few noise σ keeps the relay from chattering.
      const eps = 4 * noise;
      const { t, u, y } = relaySim(m, 0.5, 4, noise, eps);
      const r = analyzeRelay(t, u, y, { hysteresis: eps })!;
      expect(Math.abs(r.tu - tuTrue) / tuTrue).toBeLessThan(0.08);
      // The describing function is an approximation (square-ish wave): ±25 % is the textbook spread.
      expect(Math.abs(r.ku - kuTrue) / kuTrue).toBeLessThan(0.25);
    }
  });

  it('tables match Ziegler–Nichols and Tyreus–Luyben', () => {
    const zn = relayTuning(10, 0.5, 'zn-pid');
    expect(zn.kp).toBeCloseTo(6, 9);
    expect(zn.ki).toBeCloseTo(6 / 0.25, 9);
    expect(zn.kd).toBeCloseTo(6 * 0.0625, 9);
    const tl = relayTuning(10, 0.5, 'tl-pi');
    expect(tl.kp).toBeCloseTo(3.125, 9);
    expect(tl.ki).toBeCloseTo(3.125 / 1.1, 9);
    expect(relayTuning(10, 0.5, 'zn-p')).toEqual({ kp: 5, ki: 0, kd: 0 });
  });
});
