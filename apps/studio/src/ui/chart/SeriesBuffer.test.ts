import { describe, expect, it } from 'vitest';
import { SeriesBuffer, decimationGrid } from './SeriesBuffer';

describe('SeriesBuffer', () => {
  it('stores samples in order and exposes latest values', () => {
    const b = new SeriesBuffer(8);
    expect(b.length).toBe(0);
    expect(b.lastTime).toBeNaN();
    b.push(0, 1);
    b.push(1, 2);
    expect(b.length).toBe(2);
    expect(b.firstTime).toBe(0);
    expect(b.lastTime).toBe(1);
    expect(b.lastValue).toBe(2);
  });

  it('overwrites the oldest samples when full', () => {
    const b = new SeriesBuffer(4);
    for (let i = 0; i < 10; i++) b.push(i, i * 10);
    expect(b.length).toBe(4);
    expect([0, 1, 2, 3].map((i) => b.timeAt(i))).toEqual([6, 7, 8, 9]);
    expect([0, 1, 2, 3].map((i) => b.valueAt(i))).toEqual([60, 70, 80, 90]);
  });

  it('bumps version on every mutation', () => {
    const b = new SeriesBuffer(4);
    const v0 = b.version;
    b.push(0, 0);
    b.pushMany([1, 2], [1, 2]);
    expect(b.version).toBe(v0 + 3);
    b.clear();
    expect(b.version).toBe(v0 + 4);
    expect(b.length).toBe(0);
  });

  it('clears itself when the timebase goes backwards', () => {
    const b = new SeriesBuffer(8);
    b.pushMany([5, 6, 7], [1, 1, 1]);
    b.push(0.5, 9);
    expect(b.length).toBe(1);
    expect(b.firstTime).toBe(0.5);
  });

  it('binary-searches across the wrap point', () => {
    const b = new SeriesBuffer(5);
    for (let i = 0; i < 8; i++) b.push(i * 0.1, i);
    // Stored times: 0.3 .. 0.7
    expect(b.lowerBound(0)).toBe(0);
    expect(b.lowerBound(0.45)).toBe(2);
    expect(b.lowerBound(10)).toBe(5);
    expect(b.valueNear(0.52)).toBe(5);
    expect(b.valueNear(0.58)).toBe(6);
    expect(b.valueNear(-1)).toBe(3);
    expect(new SeriesBuffer(2).nearestIndex(1)).toBe(-1);
  });

  it('min/max decimates preserving spikes and their time order', () => {
    const b = new SeriesBuffer(1000);
    for (let i = 0; i < 100; i++) b.push(i / 100, i === 30 ? 50 : i === 70 ? -50 : 0);
    const out: (number | null)[] = [];
    const visited = b.decimate(0, 1, 4, out);
    expect(visited).toBe(100);
    expect(out).toHaveLength(8);
    // Bucket 1 (0.25..0.5): flat 0 then spike 50 at 0.30 → min first.
    expect(out[2]).toBe(0);
    expect(out[3]).toBe(50);
    // Bucket 2 (0.5..0.75): spike −50 at 0.70 comes after the 0 at 0.50.
    expect(out[4]).toBe(0);
    expect(out[5]).toBe(-50);
  });

  it('decimation leaves empty buckets null and skips non-finite values', () => {
    const b = new SeriesBuffer(16);
    b.push(0.1, 1);
    b.push(0.2, Number.NaN);
    b.push(0.9, 3);
    const out: (number | null)[] = [];
    b.decimate(0, 1, 4, out);
    expect(out).toEqual([1, null, null, null, null, null, 3, null]);
  });

  it('builds the matching x grid', () => {
    const xs = new Float64Array(4);
    decimationGrid(0, 2, 2, xs);
    expect([...xs]).toEqual([0.25, 0.75, 1.25, 1.75]);
  });

  it('handles a 10 kHz × 10 s window within budget', () => {
    const b = new SeriesBuffer(100_000);
    for (let i = 0; i < 100_000; i++) b.push(i / 10_000, Math.sin(i / 50));
    const out: (number | null)[] = [];
    const t0 = performance.now();
    for (let k = 0; k < 10; k++) b.decimate(0, 10, 1200, out);
    expect((performance.now() - t0) / 10).toBeLessThan(15);
  });

  it('rejects invalid capacity', () => {
    expect(() => new SeriesBuffer(1)).toThrow(RangeError);
  });
});
