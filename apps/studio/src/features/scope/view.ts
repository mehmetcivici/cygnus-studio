const MIN_SPAN = 0.002;
const MAX_SPAN = 3600;

/**
 * Time axis shared by every pane: visible span, right edge (live or frozen), pause state and
 * the two measurement cursors. Charts read it every frame; React only subscribes to the
 * discrete changes (`rev`), never to pan/zoom motion.
 */
export class ScopeView {
  span = 10;
  /** NaN while following live data. */
  end = Number.NaN;
  paused = false;
  cursors: [number | null, number | null] = [null, null];
  /** Time of the newest sample over all plotted signals (set by the owner). */
  liveNow: () => number = () => Number.NaN;
  private _rev = 0;
  private listeners = new Set<() => void>();

  get rev(): number {
    return this._rev;
  }

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  };

  private emit(): void {
    this._rev++;
    for (const l of this.listeners) l();
  }

  /** Visible `[t0, t1]`. */
  range(): [number, number] {
    const end = this.paused ? this.end : this.liveNow();
    const t1 = Number.isFinite(end) ? end : 0;
    return [t1 - this.span, t1];
  }

  setSpan(span: number): void {
    this.span = Math.min(MAX_SPAN, Math.max(MIN_SPAN, span));
    this.emit();
  }

  /** `factor < 1` zooms in. While paused the point under `at` stays put. */
  zoom(factor: number, at: number): void {
    const next = Math.min(MAX_SPAN, Math.max(MIN_SPAN, this.span * factor));
    if (this.paused && Number.isFinite(at) && Number.isFinite(this.end)) {
      const t0 = at - (at - (this.end - this.span)) * (next / this.span);
      this.end = t0 + next;
    }
    this.span = next;
    this.emit();
  }

  /** Panning freezes the live view first. */
  pan(dt: number): void {
    if (!this.paused) {
      const now = this.liveNow();
      this.end = Number.isFinite(now) ? now : 0;
      this.paused = true;
      this.end += dt;
      this.emit();
      return;
    }
    this.end += dt;
  }

  pause(at?: number): void {
    const now = at ?? this.liveNow();
    this.end = Number.isFinite(now) ? now : 0;
    this.paused = true;
    this.emit();
  }

  resume(): void {
    this.paused = false;
    this.end = Number.NaN;
    this.emit();
  }

  /** Shows `[t0, t1]` frozen (recorded data). */
  fit(t0: number, t1: number): void {
    this.span = Math.min(MAX_SPAN, Math.max(MIN_SPAN, (t1 - t0) * 1.02));
    this.end = t1 + (t1 - t0) * 0.01;
    this.paused = true;
    this.emit();
  }

  setCursor(i: 0 | 1, t: number | null): void {
    this.cursors = i === 0 ? [t, this.cursors[1]] : [this.cursors[0], t];
    this.emit();
  }

  /** Click placement: A first, then B, then whichever is nearer. */
  placeCursor(t: number): void {
    const [a, b] = this.cursors;
    if (a === null) this.setCursor(0, t);
    else if (b === null) this.setCursor(1, t);
    else this.setCursor(Math.abs(t - a) <= Math.abs(t - b) ? 0 : 1, t);
  }

  clearCursors(): void {
    this.cursors = [null, null];
    this.emit();
  }
}
