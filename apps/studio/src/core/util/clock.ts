/**
 * Time source for UI-side batching (store flushes, signal ticks). Tests pass a manual
 * implementation so no test waits on real timers.
 */
export interface UiClock {
  now(): number;
  /** Runs `cb` once after at least `ms`; in the browser aligned to the next animation frame. */
  schedule(cb: () => void, ms: number): void;
}

/** setTimeout for the delay, then requestAnimationFrame so React commits land on a paint. */
export const browserClock: UiClock = {
  now: () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
  schedule(cb, ms) {
    const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : null;
    const run = raf ? () => raf(() => cb()) : cb;
    if (ms <= 0) run();
    else setTimeout(run, ms);
  },
};

/** Deterministic clock for unit tests: `advance(ms)` runs everything that became due. */
export class ManualUiClock implements UiClock {
  private t = 0;
  private queue: Array<{ at: number; cb: () => void }> = [];

  now(): number {
    return this.t;
  }

  schedule(cb: () => void, ms: number): void {
    this.queue.push({ at: this.t + Math.max(0, ms), cb });
  }

  advance(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      this.queue.sort((a, b) => a.at - b.at);
      const next = this.queue[0];
      if (!next || next.at > end) break;
      this.queue.shift();
      this.t = Math.max(this.t, next.at);
      next.cb();
    }
    this.t = end;
  }

  get pending(): number {
    return this.queue.length;
  }
}
