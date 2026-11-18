import { classBucket } from './ids';

export interface AggSource {
  readonly length: number;
  readonly totalSeen: number;
  get(i: number): { seq: number; t: number; dir: 'rx' | 'tx'; id: number; fd: boolean; brs: boolean; data: Uint8Array } | undefined;
}

/** Latest frame and statistics of one identifier. */
export interface IdEntry {
  id: number;
  count: number;
  rxCount: number;
  txCount: number;
  lastSeq: number;
  /** Host time of the last frame, ms. */
  lastT: number;
  dir: 'rx' | 'tx';
  fd: boolean;
  brs: boolean;
  data: Uint8Array;
  /** Host time each payload byte last differed from the previous frame, ms (NaN: never). */
  changedAt: Float64Array;
  /** Smoothed inter-arrival time, ms; null until two frames were seen. */
  periodMs: number | null;
  /** Frames per second over the last rate window. */
  fps: number;
  /** Count at the previous rate sample. */
  snap: number;
}

const MAX_ENTRIES = 4096;
/** Weight of the newest interval in the period estimate. */
const EMA = 0.2;

export const freqOf = (periodMs: number | null): number | null => (periodMs && periodMs > 0 ? 1000 / periodMs : null);

/**
 * Collapses the frame stream into one row per identifier: last payload, counter, measured
 * period (exponential average of the intervals) and which bytes changed. Works incrementally
 * from the trace sequence numbers, so a refresh costs only the new frames.
 */
export class IdAggregator {
  private map = new Map<number, IdEntry>();
  private processed = 0;
  private lastRateAt = NaN;
  latestT = 0;
  /** Frames per second by class bucket and the total, from the last `sampleRates`. */
  classFps = new Map<number, number>();
  totalFps = 0;

  reset(): void {
    this.map.clear();
    this.processed = 0;
    this.lastRateAt = NaN;
    this.latestT = 0;
    this.classFps = new Map();
    this.totalFps = 0;
  }

  get size(): number {
    return this.map.size;
  }

  entry(id: number): IdEntry | undefined {
    return this.map.get(id);
  }

  entries(): IdEntry[] {
    return [...this.map.values()];
  }

  update(src: AggSource): void {
    if (src.totalSeen < this.processed) this.reset();
    const oldest = src.totalSeen - src.length;
    const from = Math.max(this.processed, oldest);
    for (let seq = from; seq < src.totalSeen; seq++) {
      const f = src.get(seq - oldest);
      if (f) this.add(f);
    }
    this.processed = src.totalSeen;
  }

  add(f: { seq: number; t: number; dir: 'rx' | 'tx'; id: number; fd: boolean; brs: boolean; data: Uint8Array }): void {
    if (f.t > this.latestT) this.latestT = f.t;
    let e = this.map.get(f.id);
    if (!e) {
      if (this.map.size >= MAX_ENTRIES) return;
      e = {
        id: f.id,
        count: 0,
        rxCount: 0,
        txCount: 0,
        lastSeq: f.seq,
        lastT: f.t,
        dir: f.dir,
        fd: f.fd,
        brs: f.brs,
        data: f.data,
        changedAt: new Float64Array(64).fill(NaN),
        periodMs: null,
        fps: 0,
        snap: 0,
      };
      this.map.set(f.id, e);
    } else {
      const dt = f.t - e.lastT;
      if (dt > 0) e.periodMs = e.periodMs === null ? dt : e.periodMs + EMA * (dt - e.periodMs);
      const n = Math.min(64, Math.max(f.data.length, e.data.length));
      for (let i = 0; i < n; i++) if (f.data[i] !== e.data[i]) e.changedAt[i] = f.t;
    }
    e.count++;
    if (f.dir === 'tx') e.txCount++;
    else e.rxCount++;
    e.lastSeq = f.seq;
    e.lastT = f.t;
    e.dir = f.dir;
    e.fd = f.fd;
    e.brs = f.brs;
    e.data = f.data;
  }

  /** Call about once a second with a wall-clock time (ms): refreshes per-id and per-class rates. */
  sampleRates(nowMs: number): void {
    const dt = Number.isNaN(this.lastRateAt) ? 0 : (nowMs - this.lastRateAt) / 1000;
    this.lastRateAt = nowMs;
    const byClass = new Map<number, number>();
    let total = 0;
    for (const e of this.map.values()) {
      const fps = dt > 0 ? (e.count - e.snap) / dt : 0;
      e.snap = e.count;
      e.fps = fps;
      total += fps;
      const k = classBucket(e.id);
      byClass.set(k, (byClass.get(k) ?? 0) + fps);
    }
    this.classFps = byClass;
    this.totalFps = total;
  }

  /** The `n` busiest identifiers of the last rate window. */
  topTalkers(n: number): IdEntry[] {
    return [...this.map.values()]
      .filter((e) => e.fps > 0)
      .sort((a, b) => b.fps - a.fps)
      .slice(0, n);
  }
}
