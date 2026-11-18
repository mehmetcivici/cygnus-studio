import type { DeviceHandle } from '@cygnus/protocol';

export interface ParamSnapshot {
  /** Value on the board as far as the host knows (undefined until read). */
  value: number | undefined;
  loading: boolean;
  /** Last read failure (writes report their errors to the caller instead). */
  error: unknown;
}

type Listener = () => void;

interface Entry {
  snap: ParamSnapshot;
  listeners: Set<Listener>;
  inflight: boolean;
}

interface Tap {
  handle: DeviceHandle | null;
  offs: Array<() => void>;
  entries: Map<string, Entry>;
  /** A `readAllParams` is running: single reads would only duplicate its traffic. */
  bulk: boolean;
}

const EMPTY: ParamSnapshot = Object.freeze({ value: undefined, loading: false, error: null });

/**
 * Parameter values per (board, key) for React: seeded from the handle's cache, refreshed by
 * `paramChanged`, re-read after `paramsInvalidated`. A watched key that is not cached is read
 * once (concurrent watchers share the request).
 */
export class ParamCache {
  private readonly taps = new Map<string, Tap>();
  private resolve: (uid48: string) => DeviceHandle | undefined = () => undefined;

  setResolver(resolve: ((uid48: string) => DeviceHandle | undefined) | null): void {
    this.resolve = resolve ?? (() => undefined);
    for (const [uid, tap] of this.taps) this.retap(uid, tap);
  }

  deviceAvailable(uid48: string): void {
    const tap = this.taps.get(uid48);
    if (tap && tap.handle !== this.resolve(uid48)) this.retap(uid48, tap);
  }

  read(uid48: string, key: string): ParamSnapshot {
    return this.taps.get(uid48)?.entries.get(key)?.snap ?? EMPTY;
  }

  subscribe(uid48: string, key: string, listener: Listener): () => void {
    let tap = this.taps.get(uid48);
    if (!tap) {
      tap = { handle: null, offs: [], entries: new Map(), bulk: false };
      this.taps.set(uid48, tap);
    }
    let entry = tap.entries.get(key);
    if (!entry) {
      entry = { snap: { value: tap.handle?.cachedParam(key), loading: false, error: null }, listeners: new Set(), inflight: false };
      tap.entries.set(key, entry);
    }
    entry.listeners.add(listener);
    if (!tap.handle) this.retap(uid48, tap);
    else this.ensureLoaded(tap, key, entry);
    const t = tap;
    const e = entry;
    return () => {
      e.listeners.delete(listener);
      if (e.listeners.size === 0) t.entries.delete(key);
      if (t.entries.size === 0) {
        for (const off of t.offs.splice(0)) off();
        this.taps.delete(uid48);
      }
    };
  }

  /**
   * Reads every parameter of a board in one sweep (forms call this on open); watched keys are
   * filled as values arrive through `paramChanged`/the cache.
   */
  async loadAll(uid48: string, onProgress?: (done: number, total: number) => void): Promise<void> {
    const h = this.resolve(uid48);
    if (!h || !h.capabilities.params) return;
    const tap = this.taps.get(uid48);
    if (tap) tap.bulk = true;
    try {
      await h.readAllParams({ onProgress: onProgress ? (p) => onProgress(p.done, p.total) : undefined });
    } finally {
      const t = this.taps.get(uid48);
      if (t) {
        t.bulk = false;
        for (const [key, e] of t.entries) this.set(e, { value: h.cachedParam(key) ?? e.snap.value, loading: false, error: e.snap.error });
      }
    }
  }

  private retap(uid48: string, tap: Tap): void {
    for (const off of tap.offs.splice(0)) off();
    const h = this.resolve(uid48) ?? null;
    tap.handle = h;
    for (const [key, e] of tap.entries) {
      e.inflight = false;
      this.set(e, { value: h?.cachedParam(key), loading: false, error: null });
    }
    if (!h) return;
    tap.offs.push(
      h.on('paramChanged', ({ key, value }) => {
        const e = tap.entries.get(key);
        if (e) this.set(e, { value, loading: false, error: null });
      }),
      h.on('paramsInvalidated', () => {
        for (const [key, e] of tap.entries) {
          this.set(e, { value: undefined, loading: false, error: null });
          this.ensureLoaded(tap, key, e);
        }
      }),
    );
    for (const [key, e] of tap.entries) this.ensureLoaded(tap, key, e);
  }

  private ensureLoaded(tap: Tap, key: string, e: Entry): void {
    const h = tap.handle;
    if (!h || e.inflight || tap.bulk || e.snap.value !== undefined || e.snap.error) return;
    if (!h.capabilities.params || !h.online || h.unassigned || h.conflict) return;
    e.inflight = true;
    this.set(e, { ...e.snap, loading: true });
    h.getParam(key).then(
      (value) => {
        e.inflight = false;
        if (tap.handle === h) this.set(e, { value, loading: false, error: null });
      },
      (error: unknown) => {
        e.inflight = false;
        if (tap.handle === h) this.set(e, { value: h.cachedParam(key), loading: false, error });
      },
    );
  }

  private set(e: Entry, snap: ParamSnapshot): void {
    const s = e.snap;
    if (s.value === snap.value && s.loading === snap.loading && s.error === snap.error) return;
    e.snap = snap;
    for (const l of e.listeners) l();
  }
}
