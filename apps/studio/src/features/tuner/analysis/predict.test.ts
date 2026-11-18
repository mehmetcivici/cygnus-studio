import { describe, expect, it } from 'vitest';
import { predictClosedLoop, slewFromRecord } from './predict';
import { fitFeedforward } from './feedforward';
import type { ProcessModel } from './model';
import { noiseSource } from './numeric';

const DT = 0.001;
const steps = (T: number, A: number, at = 0.1) => {
  const t = Float64Array.from({ length: Math.round(T / DT) }, (_, i) => i * DT);
  return { t, r: Float64Array.from(t, (x) => (x >= at ? A : 0)) };
};

describe('predictClosedLoop', () => {
  it('P control of a first-order lag: final value and closed-loop time constant', () => {
    const m: ProcessModel = { kind: 'fopdt', K: 2, tau: 0.5, theta: 0, c: 0 };
    const { t, r } = steps(5, 10);
    const p = predictClosedLoop(m, { kp: 4 }, t, r, { y0: 0 });
    const L = 2 * 4;
    expect(p.y[p.y.length - 1]).toBeCloseTo((10 * L) / (1 + L), 2);
    const tauCl = 0.5 / (1 + L);
    const yAt = p.y[Math.round((0.1 + tauCl) / DT) + 1]!;
    expect(yAt / ((10 * L) / (1 + L))).toBeCloseTo(0.632, 1);
  });

  it('integral action removes the error; feed-forward alone gives the exact steady state', () => {
    const m: ProcessModel = { kind: 'fopdt', K: 500, tau: 0.8, theta: 0.01, c: -40 };
    const { t, r } = steps(10, 3000);
    const pi = predictClosedLoop(m, { kp: 0.002, ki: 0.01 }, t, r, { y0: 0 });
    expect(Math.abs(pi.y[pi.y.length - 1]! - 3000)).toBeLessThan(5);
    const ff = predictClosedLoop(m, { kV: 1 / 500, kS: 40 / 500 }, t, r, { y0: 0 });
    expect(Math.abs(ff.y[ff.y.length - 1]! - 3000)).toBeLessThan(1);
  });

  it('respects the output limit', () => {
    const m: ProcessModel = { kind: 'fopdt', K: 1, tau: 0.1, theta: 0, c: 0 };
    const { t, r } = steps(1, 100);
    const p = predictClosedLoop(m, { kp: 10, outMax: 12 }, t, r, { y0: 0 });
    let max = 0;
    for (const u of p.u) max = Math.max(max, Math.abs(u));
    expect(max).toBeCloseTo(12, 6);
  });
});

describe('slew limit', () => {
  it('caps the rate of change and is recovered from the record', () => {
    const m: ProcessModel = { kind: 'fopdt', K: 1, tau: 0.5, theta: 0, c: 0 };
    const { t, r } = steps(2, 100);
    const p = predictClosedLoop(m, { kp: 50 }, t, r, { y0: 0, slew: 200 });
    // 100 units at 200 /s takes ~0.5 s
    expect(p.y[Math.round(0.35 / DT)]!).toBeCloseTo(50, -1);
    expect(slewFromRecord(p.t, p.y)).toBeCloseTo(200, -1);
  });
});

describe('fitFeedforward', () => {
  it('recovers kS, kV, kA from noisy ramps and steps', () => {
    const kS = 0.25;
    const kV = 1 / 470;
    const kA = 2e-4;
    const n = 12000;
    const t = Float64Array.from({ length: n }, (_, i) => i * DT);
    // Velocity: slow ramp up, a smooth step pair, then a reverse ramp.
    const w = Float64Array.from(t, (x) => {
      if (x < 4) return 1000 * x;
      if (x < 6) return 4000 - 1500 * (1 - Math.exp(-(x - 4) / 0.2));
      if (x < 8) return 2500 + 1500 * (1 - Math.exp(-(x - 6) / 0.15));
      return 4000 - 1100 * (x - 8);
    });
    const alpha = new Float64Array(n);
    for (let i = 1; i < n - 1; i++) alpha[i] = (w[i + 1]! - w[i - 1]!) / (2 * DT);
    const g = noiseSource(2);
    const u = Float64Array.from(w, (wi, i) => kS * Math.sign(wi) + kV * wi + kA * alpha[i]! + 0.01 * g());
    const wNoisy = Float64Array.from(w, (wi) => wi + 3 * g());
    const fit = fitFeedforward(t, u, wNoisy)!;
    expect(Math.abs(fit.kS - kS) / kS).toBeLessThan(0.08);
    expect(Math.abs(fit.kV - kV) / kV).toBeLessThan(0.02);
    expect(Math.abs(fit.kA - kA) / kA).toBeLessThan(0.1);
    expect(fit.r2).toBeGreaterThan(0.99);
  });

  it('ignores samples at the current limit', () => {
    const n = 4000;
    const t = Float64Array.from({ length: n }, (_, i) => i * DT);
    const w = Float64Array.from(t, (x) => 100 + 1000 * x);
    const cur = Float64Array.from(t, (x) => (x < 1 ? 60 : 10));
    // While current-limited the applied voltage does not follow the model at all.
    const u = Float64Array.from(w, (wi, i) => (i < 1000 ? 12 : 0.2 + wi / 500 + 1e-4 * 1000));
    const fit = fitFeedforward(t, u, w, { current: cur, currentLimit: 60 })!;
    expect(fit.kV).toBeCloseTo(1 / 500, 4);
    expect(fit.samples).toBeLessThan(3100);
  });
});
