import { describe, expect, it } from 'vitest';
import { identify, simulateModel, twoPointFopdt, type ProcessModel } from './model';
import { predictClosedLoop } from './predict';
import { noiseSource } from './numeric';

const DT = 0.001;

function openLoopStep(m: ProcessModel, T: number, uStep: number, noise: number, seed = 3) {
  const n = Math.round(T / DT);
  const t = new Float64Array(n);
  const u = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    t[i] = i * DT;
    u[i] = i * DT >= 0.2 ? uStep : 0;
  }
  const y = simulateModel(m, u, DT, m.kind === 'fopdt' ? m.c : 0);
  const g = noiseSource(seed);
  for (let i = 0; i < n; i++) y[i]! += noise * g();
  return { t, u, y };
}

const rel = (a: number, b: number) => Math.abs(a - b) / Math.abs(b);

describe('simulateModel', () => {
  it('reaches K·u + c with 63 % at θ + τ', () => {
    const m: ProcessModel = { kind: 'fopdt', K: 2, tau: 0.3, theta: 0.05, c: 1 };
    const u = new Float64Array(4000).fill(5);
    u[0] = 0;
    const y = simulateModel(m, u, DT, 1);
    expect(y[3999]).toBeCloseTo(11, 2);
    expect((y[Math.round((0.05 + 0.3) / DT) + 1]! - 1) / 10).toBeCloseTo(0.632, 2);
  });
  it('integrates for the integrating model', () => {
    const m: ProcessModel = { kind: 'integrating', K: 3, tau: 0, theta: 0, c: 0 };
    const y = simulateModel(m, new Float64Array(1001).fill(2), DT, 0);
    expect(y[1000]).toBeCloseTo(6, 2);
  });
});

describe('identify', () => {
  it('recovers a noisy FOPDT from an open-loop step', () => {
    const truth: ProcessModel = { kind: 'fopdt', K: 450, tau: 0.8, theta: 0.03, c: -60 };
    const { t, u, y } = openLoopStep(truth, 5, 6, 15);
    const fit = identify(t, u, y, { kind: 'fopdt' });
    expect(fit).not.toBeNull();
    const m = fit!.model;
    expect(rel(m.K, truth.K)).toBeLessThan(0.05);
    expect(rel(m.tau, truth.tau)).toBeLessThan(0.08);
    expect(Math.abs(m.theta - truth.theta)).toBeLessThan(0.015);
    expect(fit!.r2).toBeGreaterThan(0.98);
  });

  it('recovers an integrating process with lag and dead time from a doublet', () => {
    const truth: ProcessModel = { kind: 'integrating', K: 0.5, tau: 0.08, theta: 0.02, c: 0 };
    const n = 3000;
    const t = Float64Array.from({ length: n }, (_, i) => i * DT);
    const u = Float64Array.from(t, (x) => (x >= 0.2 && x < 0.8 ? 1 : x >= 0.8 && x < 1.4 ? -1 : 0));
    const y = simulateModel(truth, u, DT, 0);
    const g = noiseSource(11);
    for (let i = 0; i < n; i++) y[i]! += 0.0005 * g();
    const fit = identify(t, u, y, { kind: 'integrating' });
    const m = fit!.model;
    expect(rel(m.K, truth.K)).toBeLessThan(0.05);
    expect(Math.abs(m.tau - truth.tau)).toBeLessThan(0.02);
    expect(Math.abs(m.theta - truth.theta)).toBeLessThan(0.015);
  });

  it('identifies the plant from closed-loop step data (u and y of a P loop)', () => {
    const truth: ProcessModel = { kind: 'fopdt', K: 4, tau: 0.25, theta: 0.02, c: 0 };
    const t = Float64Array.from({ length: 2000 }, (_, i) => i * DT);
    const r = Float64Array.from(t, (x) => (x >= 0.2 ? 10 : 0));
    const p = predictClosedLoop(truth, { kp: 0.6 }, t, r, { y0: 0 });
    const g = noiseSource(5);
    const y = Float64Array.from(p.y, (v) => v + 0.02 * g());
    const fit = identify(p.t, p.u, y, { kind: 'fopdt' });
    expect(rel(fit!.model.K, 4)).toBeLessThan(0.08);
    expect(rel(fit!.model.tau, 0.25)).toBeLessThan(0.15);
  });

  it('two-point method approximates a clean FOPDT', () => {
    const truth: ProcessModel = { kind: 'fopdt', K: 2, tau: 0.5, theta: 0.1, c: 0 };
    const { t, u, y } = openLoopStep(truth, 4, 1, 0);
    const m = twoPointFopdt(t, u, y, 200)!;
    expect(rel(m.K, 2)).toBeLessThan(0.02);
    expect(rel(m.tau, 0.5)).toBeLessThan(0.05);
    expect(Math.abs(m.theta - 0.1)).toBeLessThan(0.01);
  });
});
