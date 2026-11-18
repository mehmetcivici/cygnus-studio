import { describe, expect, it } from 'vitest';
import { SeriesBuffer } from '../../ui';
import { TriggerEngine, freshScan, scanTrigger } from './trigger';

function buf(values: number[], dt = 1): SeriesBuffer {
  const b = new SeriesBuffer(values.length + 4);
  values.forEach((v, i) => b.push(i * dt, v));
  return b;
}

describe('scanTrigger', () => {
  it('finds an interpolated rising crossing', () => {
    const t = scanTrigger(buf([0, 2, 6, 8]), { level: 4, edge: 'rising' }, freshScan());
    expect(t).toBeCloseTo(1.5, 9);
  });

  it('respects the edge direction', () => {
    const b = buf([8, 6, 2, 0, 3, 7]);
    expect(scanTrigger(b, { level: 4, edge: 'rising' }, freshScan())).toBeCloseTo(4.25, 9);
    expect(scanTrigger(b, { level: 4, edge: 'falling' }, freshScan())).toBeCloseTo(1.5, 9);
  });

  it('does not fire on samples that start above the level', () => {
    expect(scanTrigger(buf([9, 9, 9]), { level: 4, edge: 'rising' }, freshScan())).toBeNull();
  });

  it('continues after an earlier hit and survives a restarted timebase', () => {
    const b = new SeriesBuffer(32);
    const st = freshScan();
    const cfg = { level: 5, edge: 'rising' } as const;
    [0, 3].forEach((v, i) => b.push(i, v));
    expect(scanTrigger(b, cfg, st)).toBeNull();
    [7, 1, 8].forEach((v, i) => b.push(2 + i, v));
    expect(scanTrigger(b, cfg, st)).toBeCloseTo(1.5, 9);
    // Reconnect: new, earlier timebase.
    b.push(0, 0);
    b.push(1, 6);
    const st2 = { lastT: 100, prev: 7 };
    expect(scanTrigger(b, cfg, st2)).toBeCloseTo(0.8333, 3);
  });

  it('skips NaN samples', () => {
    // Interpolates across the gap left by the invalid sample.
    expect(scanTrigger(buf([0, NaN, 10]), { level: 5, edge: 'rising' }, freshScan())).toBeCloseTo(1, 9);
  });
});

describe('TriggerEngine', () => {
  it('ignores data older than the arming time, then freezes after the post-trigger part', () => {
    const b = new SeriesBuffer(64);
    // An old crossing that must not fire.
    [0, 10].forEach((v, i) => b.push(i, v));
    const e = new TriggerEngine();
    e.arm({ level: 5, edge: 'rising' }, 10, 0.3, 1);
    expect(e.update(b, 1)).toBeNull();
    expect(e.phase).toBe('armed');
    b.push(2, 0);
    b.push(3, 8); // crossing at 2 + 5/8
    expect(e.update(b, 3)).toBeNull();
    expect(e.phase).toBe('waiting');
    expect(e.fireT).toBeCloseTo(2.625, 9);
    // 70 % of the 10 s window after the trigger.
    expect(e.endT).toBeCloseTo(9.625, 9);
    expect(e.update(b, 9)).toBeNull();
    expect(e.update(b, 9.7)).toBeCloseTo(9.625, 9);
    expect(e.phase).toBe('done');
    // Single shot: nothing more happens.
    b.push(10, 0);
    b.push(11, 9);
    expect(e.update(b, 11)).toBeNull();
  });

  it('can be disarmed', () => {
    const e = new TriggerEngine();
    e.arm({ level: 0, edge: 'rising' }, 1, 0.5, 0);
    e.disarm();
    expect(e.phase).toBe('off');
  });
});
