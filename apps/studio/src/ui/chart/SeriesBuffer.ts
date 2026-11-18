/**
 * Fixed-capacity ring buffer of `(time, value)` samples backed by Float64Arrays.
 *
 * - Times are seconds and must be non-decreasing. A sample older than the last
 *   one means the source's timebase restarted (device reboot, reconnect), so
 *   the buffer clears itself instead of drawing lines backwards.
 * - When full, the oldest samples are overwritten. Size it as
 *   `rate × longest window you need` (1 kHz × 60 s = 60 000).
 * - Writers never allocate; charts read it imperatively every frame.
 *   `version` increments on every mutation so readers can skip redundant work.
 */
export class SeriesBuffer {
  readonly capacity: number;
  private readonly ts: Float64Array;
  private readonly vs: Float64Array;
  private head = 0;
  private count = 0;
  private _version = 0;

  constructor(capacity = 65_536) {
    if (!Number.isInteger(capacity) || capacity < 2) throw new RangeError('SeriesBuffer capacity must be an integer ≥ 2');
    this.capacity = capacity;
    this.ts = new Float64Array(capacity);
    this.vs = new Float64Array(capacity);
  }

  /** Number of stored samples. */
  get length(): number {
    return this.count;
  }

  /** Increments on every push/clear. */
  get version(): number {
    return this._version;
  }

  /** Time of the oldest sample, NaN when empty. */
  get firstTime(): number {
    return this.count ? this.timeAt(0) : NaN;
  }

  /** Time of the newest sample, NaN when empty. */
  get lastTime(): number {
    return this.count ? (this.ts[(this.head - 1 + this.capacity) % this.capacity] ?? NaN) : NaN;
  }

  /** Newest value, NaN when empty. */
  get lastValue(): number {
    return this.count ? (this.vs[(this.head - 1 + this.capacity) % this.capacity] ?? NaN) : NaN;
  }

  /** Appends one sample. */
  push(t: number, v: number): void {
    if (this.count && t < this.lastTime) this.clear();
    this.ts[this.head] = t;
    this.vs[this.head] = v;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
    this._version++;
  }

  /** Appends `count` samples from parallel arrays (e.g. one decoded stream frame). */
  pushMany(times: ArrayLike<number>, values: ArrayLike<number>, count = Math.min(times.length, values.length)): void {
    for (let i = 0; i < count; i++) this.push(times[i] ?? NaN, values[i] ?? NaN);
  }

  clear(): void {
    this.head = 0;
    this.count = 0;
    this._version++;
  }

  private phys(i: number): number {
    return (this.head - this.count + i + this.capacity) % this.capacity;
  }

  /** Time of logical sample `i` (0 = oldest). */
  timeAt(i: number): number {
    return this.ts[this.phys(i)] ?? NaN;
  }

  /** Value of logical sample `i` (0 = oldest). */
  valueAt(i: number): number {
    return this.vs[this.phys(i)] ?? NaN;
  }

  /** Logical index of the first sample with time ≥ t (`length` if none). */
  lowerBound(t: number): number {
    let lo = 0;
    let hi = this.count;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.timeAt(mid) < t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** Logical index of the sample closest in time to t, or -1 when empty. */
  nearestIndex(t: number): number {
    if (!this.count) return -1;
    const i = this.lowerBound(t);
    if (i >= this.count) return this.count - 1;
    if (i === 0) return 0;
    return t - this.timeAt(i - 1) <= this.timeAt(i) - t ? i - 1 : i;
  }

  /** Value of the sample closest to t, NaN when empty. */
  valueNear(t: number): number {
    const i = this.nearestIndex(t);
    return i < 0 ? NaN : this.valueAt(i);
  }

  /**
   * Min/max decimation of `[t0, t1)` into `buckets` equal time buckets.
   * Writes `2 × buckets` entries into `out` starting at `offset`: for each
   * bucket the extreme that came first in time, then the other one; `null`
   * where a bucket has no (finite) sample. This keeps spikes visible at any
   * zoom while drawing at most two points per pixel column.
   * Returns the number of samples visited.
   */
  decimate(t0: number, t1: number, buckets: number, out: (number | null)[], offset = 0): number {
    const n = buckets * 2;
    for (let k = 0; k < n; k++) out[offset + k] = null;
    if (!this.count || !(t1 > t0) || buckets < 1) return 0;
    const w = (t1 - t0) / buckets;
    let cur = -1;
    let min = 0;
    let max = 0;
    let minT = 0;
    let maxT = 0;
    let visited = 0;
    const flush = (): void => {
      if (cur < 0) return;
      const o = offset + cur * 2;
      if (minT === maxT) {
        out[o] = min;
      } else if (minT < maxT) {
        out[o] = min;
        out[o + 1] = max;
      } else {
        out[o] = max;
        out[o + 1] = min;
      }
    };
    for (let i = this.lowerBound(t0); i < this.count; i++) {
      const p = this.phys(i);
      const t = this.ts[p] ?? NaN;
      if (t >= t1) break;
      visited++;
      const v = this.vs[p] ?? NaN;
      if (!Number.isFinite(v)) continue;
      const b = Math.min(buckets - 1, Math.floor((t - t0) / w));
      if (b !== cur) {
        flush();
        cur = b;
        min = max = v;
        minT = maxT = t;
      } else if (v < min) {
        min = v;
        minT = t;
      } else if (v > max) {
        max = v;
        maxT = t;
      }
    }
    flush();
    return visited;
  }
}

/** Fills `out` with the x grid matching `SeriesBuffer.decimate` slots. */
export function decimationGrid(t0: number, t1: number, buckets: number, out: Float64Array | number[]): void {
  const w = (t1 - t0) / buckets;
  for (let b = 0; b < buckets; b++) {
    out[2 * b] = t0 + (b + 0.25) * w;
    out[2 * b + 1] = t0 + (b + 0.75) * w;
  }
}
