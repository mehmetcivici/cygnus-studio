import { describe, expect, it } from 'vitest';
import { detectSteps, gradeStep, stepMetrics, stepScore } from './step';
import { noiseSource } from './numeric';

const DT = 0.001;

/** Step record: target 0 → A at tStep, measured = A·shape(t − tStep). */
function record(shape: (t: number) => number, A = 100, T = 3, tStep = 0.5, noise = 0, seed = 1) {
  const n = Math.round(T / DT);
  const t = new Float64Array(n);
  const r = new Float64Array(n);
  const y = new Float64Array(n);
  const g = noiseSource(seed);
  for (let i = 0; i < n; i++) {
    const ti = i * DT;
    t[i] = ti;
    r[i] = ti >= tStep ? A : 0;
    y[i] = (ti >= tStep ? A * shape(ti - tStep) : 0) + noise * g();
  }
  return { t, r, y };
}

const firstOrder = (tau: number) => (t: number) => 1 - Math.exp(-t / tau);
function secondOrder(zeta: number, wn: number) {
  const wd = wn * Math.sqrt(1 - zeta * zeta);
  const phi = Math.acos(zeta);
  return (t: number) => 1 - (Math.exp(-zeta * wn * t) / Math.sqrt(1 - zeta * zeta)) * Math.sin(wd * t + phi);
}

describe('detectSteps', () => {
  it('finds each edge of a square target and ignores small wiggles', () => {
    const n = 4000;
    const t = Array.from({ length: n }, (_, i) => i * DT);
    const r = t.map((ti, i) => (Math.floor(ti / 1) % 2 === 1 ? 50 : 0) + (i % 7 === 0 ? 0.5 : 0));
    const e = detectSteps(t, r);
    expect(e.map((x) => Math.round(x.t * 1000))).toEqual([1000, 2000, 3000]);
    expect(e[0]!.end).toBe(e[1]!.index);
    expect(e[2]!.end).toBe(n);
  });
  it('returns nothing for a ramp', () => {
    const t = Array.from({ length: 1000 }, (_, i) => i * DT);
    expect(detectSteps(t, t.map((x) => x * 10))).toEqual([]);
  });
});

describe('stepMetrics', () => {
  it('first-order response: rise 2.20τ, settling 3.91τ, no overshoot', () => {
    const tau = 0.2;
    const { t, r, y } = record(firstOrder(tau), 100, 3);
    const [edge] = detectSteps(t, r);
    const m = stepMetrics(t, r, y, edge!);
    expect(m.riseTime).toBeCloseTo(tau * Math.log(9), 2);
    expect(m.settlingTime).toBeGreaterThan(tau * Math.log(50) * 0.97);
    expect(m.settlingTime).toBeLessThan(tau * Math.log(50) * 1.03);
    expect(m.overshoot).toBe(0);
    expect(m.steadyErrorPct).toBeLessThan(0.1);
    expect(m.damping).toBe(1);
    expect(Number.isNaN(m.peakTime)).toBe(true);
    // IAE of a first-order step = A·τ
    expect(m.iae).toBeCloseTo(100 * tau, 0);
  });

  it('second-order ζ = 0.3: overshoot 37 %, peak time, damping from log decrement', () => {
    const zeta = 0.3;
    const wn = 12;
    const { t, r, y } = record(secondOrder(zeta, wn), 100, 3);
    const [edge] = detectSteps(t, r);
    const m = stepMetrics(t, r, y, edge!);
    const os = 100 * Math.exp((-Math.PI * zeta) / Math.sqrt(1 - zeta * zeta));
    expect(m.overshoot).toBeCloseTo(os, 0);
    expect(m.peakTime).toBeCloseTo(Math.PI / (wn * Math.sqrt(1 - zeta * zeta)), 2);
    expect(m.damping).toBeGreaterThan(0.28);
    expect(m.damping).toBeLessThan(0.32);
    expect(m.oscillations).toBeGreaterThanOrEqual(2);
    // 2 % settling envelope ≈ 4 / (ζ ωn) (loose: the envelope bound is conservative)
    expect(m.settlingTime).toBeGreaterThan(0.6 * (4 / (zeta * wn)));
    expect(m.settlingTime).toBeLessThan(1.2 * (4 / (zeta * wn)));
  });

  it('keeps damping and overshoot within tolerance on noisy data, and measures the noise', () => {
    const { t, r, y } = record(secondOrder(0.4, 15), 100, 3, 0.5, 0.5, 7);
    const [edge] = detectSteps(t, r);
    const m = stepMetrics(t, r, y, edge!);
    const os = 100 * Math.exp((-Math.PI * 0.4) / Math.sqrt(1 - 0.16));
    expect(Math.abs(m.overshoot - os)).toBeLessThan(2.5);
    expect(Math.abs(m.damping - 0.4)).toBeLessThan(0.07);
    expect(m.noiseRms).toBeGreaterThan(0.4);
    expect(m.noiseRms).toBeLessThan(0.6);
  });

  it('reports steady-state error, saturation and dead-time-shifted rise', () => {
    const n = 3000;
    const t = Array.from({ length: n }, (_, i) => i * DT);
    const r = t.map((x) => (x >= 0.5 ? 200 : 0));
    const theta = 0.05;
    const y = t.map((x) => (x >= 0.5 + theta ? 180 * (1 - Math.exp(-(x - 0.5 - theta) / 0.1)) : 0));
    const u = t.map((x) => (x >= 0.5 && x < 0.8 ? 12 : 4));
    const [edge] = detectSteps(t, r);
    const m = stepMetrics(t, r, y, edge!, { output: u, outputLimit: 12 });
    expect(m.steadyError).toBeCloseTo(20, 0);
    expect(m.steadyErrorPct).toBeCloseTo(10, 0);
    expect(m.saturation).toBeCloseTo((0.3 / 2.5) * 100, 0);
    expect(m.riseTime).toBeCloseTo(0.1 * Math.log(9), 2);
    const { tips } = gradeStep(m);
    expect(tips).toContain('steadyError');
  });

  it('grades a clean response as good and scores a better run lower', () => {
    const good = record(firstOrder(0.05));
    const bad = record(secondOrder(0.15, 10));
    const mg = stepMetrics(good.t, good.r, good.y, detectSteps(good.t, good.r)[0]!);
    const mb = stepMetrics(bad.t, bad.r, bad.y, detectSteps(bad.t, bad.r)[0]!);
    expect(gradeStep(mg).tips).toEqual(['good']);
    const gb = gradeStep(mb);
    expect(gb.tips).toContain('overshootHigh');
    expect(gb.tips).toContain('oscillating');
    expect(gb.grades.find((g) => g.key === 'overshoot')?.grade).toBe('poor');
    expect(stepScore(mg)).toBeLessThan(stepScore(mb));
  });

  it('flags a step the measurement did not follow', () => {
    const { t, r } = record(() => 0, 100, 2);
    const g = noiseSource(3);
    const y = Array.from(t, (x) => (x >= 0.5 ? 1.5 : 0) + 0.3 * g());
    const m = stepMetrics(t, r, y, detectSteps(t, r)[0]!);
    expect(m.noResponse).toBe(true);
    expect(Number.isNaN(m.overshoot)).toBe(true);
    expect(m.steadyErrorPct).toBeGreaterThan(95);
    expect(gradeStep(m).tips[0]).toBe('noResponse');
    expect(stepScore(m)).toBe(Infinity);
  });

  it('handles a downward step symmetrically', () => {
    const tau = 0.1;
    const n = 2000;
    const t = Array.from({ length: n }, (_, i) => i * DT);
    const r = t.map((x) => (x >= 0.5 ? 0 : 100));
    const y = t.map((x) => (x >= 0.5 ? 100 * Math.exp(-(x - 0.5) / tau) : 100));
    const m = stepMetrics(t, r, y, detectSteps(t, r)[0]!);
    expect(m.riseTime).toBeCloseTo(tau * Math.log(9), 2);
    expect(m.overshoot).toBe(0);
  });
});
