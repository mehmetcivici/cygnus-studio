import { describe, expect, it } from 'vitest';
import { ManualScheduler, realScheduler } from '../src';

describe('ManualScheduler', () => {
  it('fires timers in due order with now() at their due time', () => {
    const s = new ManualScheduler(100);
    const log: string[] = [];
    s.setTimeout(() => log.push(`b@${s.now()}`), 20);
    s.setTimeout(() => log.push(`a@${s.now()}`), 10);
    s.setTimeout(() => log.push(`c@${s.now()}`), 20);
    s.advance(15);
    expect(log).toEqual(['a@110']);
    expect(s.now()).toBe(115);
    s.advance(5);
    expect(log).toEqual(['a@110', 'b@120', 'c@120']);
  });

  it('runs timers scheduled from callbacks inside the same advance', () => {
    const s = new ManualScheduler();
    const log: number[] = [];
    const tick = () => {
      log.push(s.now());
      if (log.length < 5) s.setTimeout(tick, 10);
    };
    s.setTimeout(tick, 10);
    s.advance(35);
    expect(log).toEqual([10, 20, 30]);
    s.runAll();
    expect(log).toEqual([10, 20, 30, 40, 50]);
    expect(s.pending).toBe(0);
  });

  it('clearTimeout cancels and zero/negative delays fire on the next advance', () => {
    const s = new ManualScheduler();
    let hit = 0;
    const h = s.setTimeout(() => hit++, 5);
    s.clearTimeout(h);
    s.setTimeout(() => hit++, -3);
    s.advance(0);
    expect(hit).toBe(1);
    s.advance(10);
    expect(hit).toBe(1);
  });
});

describe('realScheduler', () => {
  it('reads a monotonic clock', () => {
    const a = realScheduler.now();
    expect(realScheduler.now()).toBeGreaterThanOrEqual(a);
  });
});
