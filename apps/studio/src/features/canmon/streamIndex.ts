import { compileFilter, EMPTY_FILTER, FLAG_ERROR, FLAG_UNANSWERED, type CompiledFilter, type FrameFilter } from './filter';

export interface IndexSource {
  readonly length: number;
  readonly totalSeen: number;
  idAt(i: number): number;
  dirAt(i: number): 'rx' | 'tx';
  get(i: number): { data: Uint8Array } | undefined;
}

/**
 * Sequence numbers of the frames that pass the filter, oldest first. Without "problems only"
 * the list grows incrementally (new frames are tested once); with it the list is rebuilt
 * because annotations (a request timing out) can change after a frame was seen.
 */
export class StreamIndex {
  private rows: number[] = [];
  private processed = 0;
  private sig = '';
  private compiled: CompiledFilter = compileFilter(EMPTY_FILTER);
  private snapshot: number[] = [];
  private changed = true;

  reset(): void {
    this.rows = [];
    this.processed = 0;
    this.sig = '';
    this.changed = true;
  }

  /** Brings the index up to date; returns the (stable until the next change) row list. */
  update(src: IndexSource, filter: FrameFilter, flagsOf: (seq: number) => number): readonly number[] {
    const sig = JSON.stringify(filter);
    if (sig !== this.sig || src.totalSeen < this.processed) {
      this.sig = sig;
      this.compiled = compileFilter(filter);
      this.rows = [];
      this.processed = 0;
      this.changed = true;
    }
    const oldest = src.totalSeen - src.length;
    if (filter.problemsOnly) {
      this.rows = [];
      this.processed = 0;
      this.changed = true;
    }
    let drop = 0;
    while (drop < this.rows.length && (this.rows[drop] ?? 0) < oldest) drop++;
    if (drop > 0) {
      this.rows.splice(0, drop);
      this.changed = true;
    }
    const noFilter = sig === JSON.stringify(EMPTY_FILTER);
    for (let seq = Math.max(this.processed, oldest); seq < src.totalSeen; seq++) {
      const i = seq - oldest;
      if (!noFilter) {
        const data = this.compiled.needsData ? (src.get(i)?.data ?? null) : null;
        if (!this.compiled.match({ id: src.idAt(i), dir: src.dirAt(i), flags: flagsOf(seq) & (FLAG_ERROR | FLAG_UNANSWERED) }, data)) continue;
      }
      this.rows.push(seq);
      this.changed = true;
    }
    this.processed = src.totalSeen;
    if (this.changed) {
      this.snapshot = this.rows.slice();
      this.changed = false;
    }
    return this.snapshot;
  }
}
