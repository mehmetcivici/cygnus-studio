import type { SampleSeries } from './measure';

export type TriggerEdge = 'rising' | 'falling';

export interface TriggerConfig {
  level: number;
  edge: TriggerEdge;
}

export interface TriggerScanState {
  /** Time of the last sample already examined. */
  lastT: number;
  /** Value of that sample (NaN before the first one). */
  prev: number;
}

export const freshScan = (after = -Infinity): TriggerScanState => ({ lastT: after, prev: NaN });

/**
 * Examines samples newer than `state.lastT` and returns the interpolated time at which the
 * signal first crosses the level in the configured direction, or null. The state advances up
 * to the crossing so a later call continues after it.
 */
export function scanTrigger(s: SampleSeries, cfg: TriggerConfig, state: TriggerScanState): number | null {
  const n = s.length;
  if (!n) return null;
  // The buffer restarted its timebase (reconnect): forget what we saw.
  if (s.timeAt(n - 1) < state.lastT) {
    state.lastT = -Infinity;
    state.prev = NaN;
  }
  let i = s.lowerBound(state.lastT);
  while (i < n && s.timeAt(i) <= state.lastT) i++;
  for (; i < n; i++) {
    const t = s.timeAt(i);
    const v = s.valueAt(i);
    if (!Number.isFinite(v)) continue;
    const p = state.prev;
    const pt = state.lastT;
    state.lastT = t;
    state.prev = v;
    if (Number.isNaN(p)) continue;
    const crossed = cfg.edge === 'rising' ? p < cfg.level && v >= cfg.level : p > cfg.level && v <= cfg.level;
    if (crossed) {
      const f = v === p ? 1 : (cfg.level - p) / (v - p);
      return Number.isFinite(pt) ? pt + f * (t - pt) : t;
    }
  }
  return null;
}

export type TriggerPhase = 'off' | 'armed' | 'waiting' | 'done';

/**
 * Single-shot trigger. After the crossing it waits until `(1 - pre)` of the window has been
 * recorded, then reports the time at which the view must freeze so the crossing sits at
 * `pre` of the window width.
 */
export class TriggerEngine {
  phase: TriggerPhase = 'off';
  fireT = NaN;
  endT = NaN;
  private cfg: TriggerConfig = { level: 0, edge: 'rising' };
  private span = 10;
  private pre = 0.5;
  private scan = freshScan();

  /** `now` is the newest sample time; older data never triggers. */
  arm(cfg: TriggerConfig, spanS: number, preFrac: number, now: number): void {
    this.cfg = cfg;
    this.span = spanS;
    this.pre = Math.min(1, Math.max(0, preFrac));
    this.scan = freshScan(Number.isFinite(now) ? now : -Infinity);
    this.fireT = NaN;
    this.endT = NaN;
    this.phase = 'armed';
  }

  disarm(): void {
    this.phase = 'off';
    this.fireT = NaN;
    this.endT = NaN;
  }

  /** Returns the freeze time when the capture is complete (once), else null. */
  update(s: SampleSeries | null, now: number): number | null {
    if (this.phase === 'armed' && s) {
      const t = scanTrigger(s, this.cfg, this.scan);
      if (t !== null) {
        this.fireT = t;
        this.endT = t + (1 - this.pre) * this.span;
        this.phase = 'waiting';
      }
    }
    if (this.phase === 'waiting' && now >= this.endT) {
      this.phase = 'done';
      return this.endT;
    }
    return null;
  }
}
