/** Decoded rows kept; the visible window is ~30 rows, so this covers long scrolls. */
export const ROW_CACHE_MAX = 4000;

interface Source<F> {
  readonly length: number;
  readonly totalSeen: number;
  get(i: number): F | undefined;
}

/**
 * Per-frame decoding kept across trace refreshes, keyed by sequence number: a traced frame never
 * changes, so only rows that scroll into view for the first time are decoded (CAN monitor at
 * 25 boards / 4 k frames/s re-decoded every visible row ten times a second before).
 */
export class RowDecodeCache<F extends { seq: number }, D> {
  private readonly infos = new Map<number, { f: F; desc: D } | null>();

  constructor(private readonly decode: (f: F) => D, private readonly max = ROW_CACHE_MAX) {}

  /** Lookup bound to the trace as it is now (call once per refresh). */
  view(src: Source<F>): { info(seq: number): { f: F; desc: D } | null; frame(seq: number): F | null } {
    const base = src.totalSeen - src.length;
    if (this.infos.size > this.max) {
      for (const k of this.infos.keys()) {
        if (this.infos.size <= this.max / 2) break;
        this.infos.delete(k);
      }
    }
    const infos = this.infos;
    const frame = (seq: number): F | null => {
      const f = src.get(seq - base);
      return f && f.seq === seq ? f : null;
    };
    return {
      info: (seq) => {
        let v = infos.get(seq);
        if (v === undefined || (v === null && seq >= base)) {
          const f = frame(seq);
          v = f ? { f, desc: this.decode(f) } : null;
          infos.set(seq, v);
        }
        return v;
      },
      frame: (seq) => infos.get(seq)?.f ?? frame(seq),
    };
  }
}
