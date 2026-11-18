import { describe, expect, it } from 'vitest';
import { estimateResponse, loopResponse, margins, modelResponse, toBode } from './bode';
import { simulateModel, type ProcessModel } from './model';
import { noiseSource } from './numeric';
import { chirpValue } from '../signals';
import { modelUltimate } from './relay';

const DT = 0.001;

describe('frequency response', () => {
  it('estimates a FOPDT plant from a log chirp within 1 dB / 6°', () => {
    const m: ProcessModel = { kind: 'fopdt', K: 3, tau: 0.05, theta: 0.004, c: 0 };
    const T = 20;
    const n = Math.round(T / DT);
    const t = Float64Array.from({ length: n }, (_, i) => i * DT);
    const u = Float64Array.from(t, (x) => chirpValue(x, T, 0.5, 40, 1));
    const y = simulateModel(m, u, DT, 0);
    const g = noiseSource(4);
    for (let i = 0; i < n; i++) y[i]! += 0.01 * g();
    const est = toBode(estimateResponse(t, u, y, 0.7, 30, 24));
    const ref = toBode(modelResponse(m, est.f));
    expect(est.f.length).toBeGreaterThan(15);
    for (let i = 0; i < est.f.length; i++) {
      expect(Math.abs(est.magDb[i]! - ref.magDb[i]!)).toBeLessThan(1);
      expect(Math.abs(est.phaseDeg[i]! - ref.phaseDeg[i]!)).toBeLessThan(6);
    }
  });

  it('margins of L = 10 / (s (0.1 s + 1)): PM ≈ 51.8°, no gain margin', () => {
    const p: ProcessModel = { kind: 'integrating', K: 1, tau: 0.1, theta: 0, c: 0 };
    const fs = Float64Array.from({ length: 400 }, (_, i) => 0.01 * 10 ** (i / 100));
    const b = toBode(loopResponse(modelResponse(p, fs), { kp: 10 }));
    const mg = margins(b);
    // |L| = 1: ω² (1 + 0.01 ω²) = 100 → ω = 7.86 rad/s
    expect(mg.gainCrossHz * 2 * Math.PI).toBeCloseTo(7.86, 1);
    expect(mg.phaseMarginDeg).toBeCloseTo(90 - (Math.atan(0.786) * 180) / Math.PI, 0);
    expect(mg.gainMarginDb).toBe(Infinity);
  });

  it('gain margin of a P loop on a FOPDT equals the ultimate gain ratio', () => {
    const p: ProcessModel = { kind: 'fopdt', K: 1, tau: 0.2, theta: 0.05, c: 0 };
    const { ku, tu } = modelUltimate(p)!;
    const w = (2 * Math.PI) / tu;
    const fs = Float64Array.from({ length: 500 }, (_, i) => 0.05 * 10 ** (i / 125));
    const mg = margins(toBode(loopResponse(modelResponse(p, fs), { kp: ku / 2 })));
    expect(mg.gainMarginDb).toBeCloseTo(20 * Math.log10(2), 1);
    expect(mg.phaseCrossHz * 2 * Math.PI).toBeCloseTo(w, 1);
  });
});
