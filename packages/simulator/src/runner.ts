import type { Scheduler } from '@cygnus/protocol';
import type { Simulation } from './simulation';

export interface RealtimeRunnerOptions {
  /** Scheduler tick, ms (default 4). */
  tickMs?: number;
  /**
   * Longest stretch of simulated time caught up in one tick (default 100 ms). A background
   * tab can stall timers for seconds; the excess is dropped rather than replayed in a burst.
   */
  maxCatchUpMs?: number;
  /** Simulated ms per wall-clock ms (default 1). */
  speed?: number;
}

/** Drives a Simulation from a Scheduler so it runs in step with the wall clock. */
export class RealtimeRunner {
  private handle: unknown = null;
  private last = 0;
  private readonly tickMs: number;
  private readonly maxCatchUpMs: number;
  speed: number;
  /** Simulated time dropped because the host fell behind (ms). */
  droppedMs = 0;

  constructor(
    private readonly sim: Simulation,
    private readonly scheduler: Scheduler,
    o: RealtimeRunnerOptions = {},
  ) {
    this.tickMs = o.tickMs ?? 4;
    this.maxCatchUpMs = o.maxCatchUpMs ?? 100;
    this.speed = o.speed ?? 1;
  }

  get running(): boolean {
    return this.handle !== null;
  }

  start(): void {
    if (this.handle !== null) return;
    this.last = this.scheduler.now();
    this.sim.hostTimeOffset = this.last - this.sim.timeMs;
    this.schedule();
  }

  stop(): void {
    if (this.handle === null) return;
    this.scheduler.clearTimeout(this.handle);
    this.handle = null;
  }

  private schedule(): void {
    this.handle = this.scheduler.setTimeout(() => this.tick(), this.tickMs);
  }

  private tick(): void {
    const now = this.scheduler.now();
    let elapsed = (now - this.last) * this.speed;
    this.last = now;
    if (elapsed > this.maxCatchUpMs) {
      this.droppedMs += elapsed - this.maxCatchUpMs;
      elapsed = this.maxCatchUpMs;
    }
    this.sim.advance(elapsed);
    // Keep host timestamps on the scheduler clock even after dropped time or a speed change.
    this.sim.hostTimeOffset = now - this.sim.timeMs;
    if (this.handle !== null) this.schedule();
  }
}
