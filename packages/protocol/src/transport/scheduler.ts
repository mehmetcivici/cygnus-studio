import type { Scheduler } from './types';

interface TimerGlobals {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  performance?: { now(): number };
}

/**
 * Wall-clock scheduler. This is the single place in the package that touches timer globals;
 * everything else receives a Scheduler.
 */
export const realScheduler: Scheduler = {
  now(): number {
    const g = globalThis as unknown as TimerGlobals;
    return g.performance ? g.performance.now() : Date.now();
  },
  setTimeout(fn: () => void, ms: number): unknown {
    return (globalThis as unknown as TimerGlobals).setTimeout(fn, ms);
  },
  clearTimeout(handle: unknown): void {
    (globalThis as unknown as TimerGlobals).clearTimeout(handle);
  },
};

interface ManualTimer {
  id: number;
  due: number;
  fn: () => void;
}

/**
 * Deterministic scheduler for tests: time moves only through `advance`. Timers fire in due
 * order (ties in scheduling order), with `now()` equal to their due time while they run;
 * timers scheduled by a callback fire in the same `advance` call if they fall inside it.
 */
export class ManualScheduler implements Scheduler {
  private time: number;
  private nextId = 1;
  private timers: ManualTimer[] = [];

  constructor(startMs = 0) {
    this.time = startMs;
  }

  now(): number {
    return this.time;
  }

  setTimeout(fn: () => void, ms: number): number {
    const t: ManualTimer = { id: this.nextId++, due: this.time + Math.max(0, ms), fn };
    // Keep sorted by (due, id); insertion after equal due times preserves FIFO order.
    let i = this.timers.length;
    while (i > 0 && (this.timers[i - 1]?.due ?? 0) > t.due) i--;
    this.timers.splice(i, 0, t);
    return t.id;
  }

  clearTimeout(handle: unknown): void {
    const i = this.timers.findIndex((t) => t.id === handle);
    if (i >= 0) this.timers.splice(i, 1);
  }

  /** Moves time forward by `ms`, running every timer that comes due on the way. */
  advance(ms: number): void {
    const end = this.time + Math.max(0, ms);
    for (;;) {
      const t = this.timers[0];
      if (!t || t.due > end) break;
      this.timers.shift();
      this.time = t.due;
      t.fn();
    }
    this.time = end;
  }

  /** Runs timers until none are left or `limitMs` of simulated time has passed. */
  runAll(limitMs = 60_000): void {
    const end = this.time + limitMs;
    while (this.timers.length > 0 && (this.timers[0]?.due ?? Infinity) <= end) {
      this.advance((this.timers[0]?.due ?? end) - this.time);
    }
  }

  get pending(): number {
    return this.timers.length;
  }
}
