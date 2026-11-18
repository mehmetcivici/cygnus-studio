import type { DeviceHandle, SignalUpdate } from '@cygnus/protocol';
import { browserClock, type UiClock } from '../util/clock';

type Listener = () => void;

interface Entry {
  /** Latest value from the board. */
  latest: number;
  /** Value React sees; changes only on a tick. */
  published: number;
  listeners: Set<Listener>;
}

interface Tap {
  handle: DeviceHandle | null;
  off: (() => void) | null;
  entries: Map<string, Entry>;
}

/** Re-render ceiling for live values: 20 Hz is smooth to the eye and cheap for React. */
export const SIGNAL_TICK_MS = 50;

/**
 * Fan-out of STATUS signal values to React with a render budget. Each board gets one
 * `onSignals` subscription while anything watches it; values are written on every frame but
 * published (and listeners notified) at most once per `SIGNAL_TICK_MS`, and only for keys that
 * actually changed. A 1 kHz signal therefore costs ≤ 20 renders/s per watching component.
 */
export class SignalHub {
  private readonly taps = new Map<string, Tap>();
  private readonly dirty = new Set<Entry>();
  private scheduled = false;
  private lastTick = -Infinity;
  private resolve: (uid48: string) => DeviceHandle | undefined = () => undefined;

  constructor(
    private readonly clock: UiClock = browserClock,
    readonly tickMs = SIGNAL_TICK_MS,
  ) {}

  /** Points the hub at a bus (or none). Existing subscriptions re-tap on the new handles. */
  setResolver(resolve: ((uid48: string) => DeviceHandle | undefined) | null): void {
    this.resolve = resolve ?? (() => undefined);
    for (const [uid, tap] of this.taps) this.retap(uid, tap);
  }

  /** A board appeared or came back: (re)attach if anyone watches it. */
  deviceAvailable(uid48: string): void {
    const tap = this.taps.get(uid48);
    if (tap && tap.handle !== this.resolve(uid48)) this.retap(uid48, tap);
  }

  subscribe(uid48: string, key: string, listener: Listener): () => void {
    let tap = this.taps.get(uid48);
    if (!tap) {
      tap = { handle: null, off: null, entries: new Map() };
      this.taps.set(uid48, tap);
    }
    let entry = tap.entries.get(key);
    if (!entry) {
      const v = tap.handle ? tap.handle.getSignal(key) : NaN;
      entry = { latest: v, published: v, listeners: new Set() };
      tap.entries.set(key, entry);
    }
    entry.listeners.add(listener);
    if (!tap.handle) this.retap(uid48, tap);
    const e = entry;
    const t = tap;
    return () => {
      e.listeners.delete(listener);
      if (e.listeners.size === 0) {
        t.entries.delete(key);
        this.dirty.delete(e);
      }
      if (t.entries.size === 0) {
        t.off?.();
        this.taps.delete(uid48);
      }
    };
  }

  /** Published value (NaN until the first STATUS frame carrying it). */
  read(uid48: string, key: string): number {
    return this.taps.get(uid48)?.entries.get(key)?.published ?? NaN;
  }

  /** Number of boards with a live `onSignals` subscription (leak checks in tests). */
  get tapCount(): number {
    let n = 0;
    for (const t of this.taps.values()) if (t.off) n++;
    return n;
  }

  private retap(uid48: string, tap: Tap): void {
    tap.off?.();
    tap.off = null;
    const h = this.resolve(uid48) ?? null;
    tap.handle = h;
    if (h) {
      tap.off = h.onSignals((u) => this.onUpdate(tap, u));
      for (const [key, e] of tap.entries) this.write(e, h.getSignal(key));
    } else {
      for (const e of tap.entries.values()) this.write(e, NaN);
    }
  }

  private onUpdate(tap: Tap, u: SignalUpdate): void {
    // Few watched keys per board: walk ours, not the frame's.
    for (const key of u.keys) {
      const e = tap.entries.get(key);
      if (e) this.write(e, u.values[key] ?? NaN);
    }
  }

  private write(e: Entry, v: number): void {
    e.latest = v;
    if (Object.is(v, e.published)) {
      this.dirty.delete(e);
      return;
    }
    this.dirty.add(e);
    if (this.scheduled) return;
    this.scheduled = true;
    this.clock.schedule(this.tick, Math.max(0, this.lastTick + this.tickMs - this.clock.now()));
  }

  private readonly tick = (): void => {
    this.scheduled = false;
    this.lastTick = this.clock.now();
    const batch = [...this.dirty];
    this.dirty.clear();
    for (const e of batch) e.published = e.latest;
    for (const e of batch) for (const l of e.listeners) l();
  };
}
