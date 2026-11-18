import { describe, expect, it } from 'vitest';
import { SeriesBuffer } from '../../ui';
import { cursorDelta, measureSignal, rangeStats, valueAtTime } from './measure';

function ramp(n: number, dt = 0.1, f = (i: number): number => i): SeriesBuffer {
  const b = new SeriesBuffer(n + 2);
  for (let i = 0; i < n; i++) b.push(i * dt, f(i));
  return b;
}

describe('rangeStats', () => {
  it('computes min, max, mean and RMS over an inclusive range', () => {
    const b = ramp(11); // t = 0..1, v = 0..10
    const s = rangeStats(b, 0.2, 0.4); // v = 2, 3, 4
    expect(s).toEqual({ count: 3, min: 2, max: 4, mean: 3, rms: Math.sqrt((4 + 9 + 16) / 3) });
  });

  it('ignores non-finite samples and returns null for an empty range', () => {
    const b = new SeriesBuffer(8);
    b.push(0, 1);
    b.push(1, NaN);
    b.push(2, 3);
    expect(rangeStats(b, 0, 2)?.count).toBe(2);
    expect(rangeStats(b, 5, 6)).toBeNull();
    expect(rangeStats(b, 2, 1)).toBeNull();
  });

  it('gives RMS of a sine close to amplitude / sqrt(2)', () => {
    const b = ramp(1000, 0.001, (i) => 2 * Math.sin((2 * Math.PI * i) / 100));
    const s = rangeStats(b, 0, 1);
    expect(s?.rms).toBeCloseTo(Math.SQRT2, 2);
    expect(s?.mean).toBeCloseTo(0, 2);
  });
});

describe('cursor measurements', () => {
  it('reads the nearest sample and clamps outside the data', () => {
    const b = ramp(5); // t 0..0.4
    expect(valueAtTime(b, 0.21)).toBe(2);
    expect(valueAtTime(b, -3)).toBe(0);
    expect(valueAtTime(b, 9)).toBe(4);
    expect(valueAtTime(new SeriesBuffer(4), 1)).toBeNaN();
  });

  it('gives dt, frequency and sign', () => {
    expect(cursorDelta(1, 1.004).dt).toBeCloseTo(0.004, 12);
    expect(cursorDelta(1, 1.004).freq).toBeCloseTo(250, 6);
    expect(cursorDelta(2, 1).dt).toBe(-1);
    expect(cursorDelta(2, 1).freq).toBe(1);
    expect(cursorDelta(3, 3).freq).toBeNull();
  });

  it('measures between cursors in either order', () => {
    const b = ramp(11, 1);
    const m = measureSignal(b, 6, 2);
    expect(m.atA).toBe(6);
    expect(m.atB).toBe(2);
    expect(m.dy).toBe(-4);
    expect(m.between).toMatchObject({ min: 2, max: 6, mean: 4, count: 5 });
  });
});
