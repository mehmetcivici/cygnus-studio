import { describe, expect, it } from 'vitest';
import { chirpFrequency, defaultSignal, signalDuration, signalExtent, signalValue } from './signals';

describe('test signals', () => {
  it('step: lead-in at A, then B and back to A per repeat', () => {
    const c = { ...defaultSignal('step', 1000), pre: 0.5, hold: 1, repeats: 2 };
    expect(signalDuration(c)).toBeCloseTo(4.5);
    expect(signalValue(c, 0.2)).toBe(0);
    expect(signalValue(c, 0.6)).toBe(1000);
    expect(signalValue(c, 1.6)).toBe(0);
    expect(signalValue(c, 2.6)).toBe(1000);
    expect(signalValue(c, 10)).toBe(0);
    expect(signalExtent(c)).toEqual([0, 1000]);
  });

  it('square and sine stay inside offset ± amplitude', () => {
    const sq = { ...defaultSignal('square', 0), offset: 100, amplitude: 50, period: 1, repeats: 3, pre: 0 };
    expect(signalValue(sq, 0.25)).toBe(150);
    expect(signalValue(sq, 0.75)).toBe(50);
    expect(signalExtent(sq)).toEqual([50, 150]);
    const si = { ...defaultSignal('sine', 0), offset: 0, amplitude: 2, freq: 2, repeats: 1, pre: 0 };
    expect(signalValue(si, 0.125)).toBeCloseTo(2);
    expect(signalDuration(si)).toBeCloseTo(0.5);
  });

  it('trapezoid ramps linearly', () => {
    const c = { ...defaultSignal('trapezoid', 100), pre: 0, ramp: 1, hold: 0.5 };
    expect(signalValue(c, 0.5)).toBeCloseTo(50);
    expect(signalValue(c, 1.2)).toBe(100);
    expect(signalValue(c, 2)).toBeCloseTo(50);
  });

  it('chirp sweeps logarithmically between f0 and f1', () => {
    expect(chirpFrequency(0, 10, 1, 100)).toBeCloseTo(1);
    expect(chirpFrequency(5, 10, 1, 100)).toBeCloseTo(10);
    expect(chirpFrequency(10, 10, 1, 100)).toBeCloseTo(100);
    const c = { ...defaultSignal('chirp', 0), offset: 5, amplitude: 1, f0: 1, f1: 10, sweep: 4, pre: 0 };
    let lo = Infinity;
    let hi = -Infinity;
    for (let t = 0; t < 4; t += 0.001) {
      const v = signalValue(c, t);
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
    expect(lo).toBeGreaterThanOrEqual(4 - 1e-9);
    expect(hi).toBeLessThanOrEqual(6 + 1e-9);
  });
});
