import { Timing, type Scheduler } from '@cygnus/protocol';
import type { Simulation } from './simulation';

export interface RealtimeRunnerOptions {
  /** Scheduler tick, ms (default 4). */
  tickMs?: number;
  /**
   * Longest stretch of simulated time caught up in one tick (default 2000 ms). Background tabs
   * run timers about once a second: the simulation must keep pace through such gaps, or the
   * boards miss heartbeats and the host takes them for lost. Longer stalls are dropped.
   */
  maxCatchUpMs?: number;
  /** Simulated ms per wall-clock ms (default 1). */
  speed?: number;
}

/** Catch-up limit while the machine cannot keep up with real time (keeps the page responsive). */
const CPU_BOUND_CATCH_UP_MS = 100;

/** Drives a Simulation from a Scheduler so it runs in step with the wall clock. */
export class RealtimeRunner {
  private handle: unknown = null;
  private last = 0;
  private readonly tickMs: number;
  private readonly maxCatchUpMs: number;
  /** The last advance took longer than the time it simulated. */
  private cpuBound = false;
  speed: number;
  /** Simulated time dropped because the host fell behind (ms). */
  droppedMs = 0;

  constructor(
    private readonly sim: Simulation,
    private readonly scheduler: Scheduler,
    o: RealtimeRunnerOptions = {},
  ) {
    this.tickMs = o.tickMs ?? 4;
    this.maxCatchUpMs = Math.max(o.maxCatchUpMs ?? Timing.LOST_AFTER_MS + 500, this.tickMs);
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
    const cap = this.cpuBound ? Math.min(this.maxCatchUpMs, CPU_BOUND_CATCH_UP_MS) : this.maxCatchUpMs;
    if (elapsed > cap) {
      this.droppedMs += elapsed - cap;
      elapsed = cap;
    }
    // Frames of this catch-up are stamped so that it ends at `now`: node clocks and the host
    // clock agree even when time was dropped, and the last heartbeats look as fresh to the
    // host as they are on the simulated bus.
    const start = this.sim.timeMs;
    this.sim.hostTimeOffset = now - (start + elapsed);
    this.sim.advance(elapsed);
    this.sim.hostTimeOffset = now - this.sim.timeMs;
    const simulated = this.sim.timeMs - start;
    if (simulated > 0) this.cpuBound = this.scheduler.now() - now > simulated / this.speed;
    if (this.handle !== null) this.schedule();
  }
}
