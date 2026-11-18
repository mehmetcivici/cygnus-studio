import type { DeviceHandle } from '@cygnus/protocol';

/**
 * Remembers what a board holds in flash, so "revert to saved" works without a reboot (the
 * protocol has no LOAD_SAVED command). While the board reports no unsaved changes, values it
 * reports equal its flash; a save (or the UNSAVED flag clearing) refreshes the whole snapshot.
 * Values seen while UNSAVED is set are ignored.
 */
class SavedBaseline {
  readonly values = new Map<string, number>();
  private wasUnsaved: boolean;

  constructor(private readonly h: DeviceHandle) {
    this.wasUnsaved = h.flags.unsaved;
    if (!h.flags.unsaved) this.takeAll();
    h.on('paramChanged', ({ key, value }) => {
      // A user write arrives before the heartbeat raises UNSAVED: never overwrite known keys.
      if (!this.h.flags.unsaved && !this.values.has(key)) this.values.set(key, value);
    });
    h.on('changed', () => {
      const unsaved = this.h.flags.unsaved;
      if (this.wasUnsaved && !unsaved) this.takeAll();
      this.wasUnsaved = unsaved;
    });
  }

  takeAll(): void {
    for (const [k, v] of this.h.params) this.values.set(k, v);
  }
}

const tracked = new WeakMap<DeviceHandle, SavedBaseline>();

/** Starts tracking a board (idempotent). Call when the screen opens a board. */
export function trackSaved(h: DeviceHandle): void {
  if (!tracked.has(h) && h.capabilities.params) tracked.set(h, new SavedBaseline(h));
}

/** Call after a successful SAVE_PARAMS: the board's current values are now its flash. */
export function markSaved(h: DeviceHandle): void {
  tracked.get(h)?.takeAll();
}

export interface SavedDiff {
  /** Keys whose current value differs from the remembered flash value. */
  writes: Array<{ key: string; from: number; to: number }>;
  /** Writable parameters whose flash value is not known. */
  unknown: string[];
}

/** Writable parameters that differ from what the board last saved. */
export function diffFromSaved(h: DeviceHandle): SavedDiff {
  const base = tracked.get(h)?.values;
  const writes: SavedDiff['writes'] = [];
  const unknown: string[] = [];
  for (const p of h.def?.params ?? []) {
    if (p.readOnly) continue;
    const saved = base?.get(p.key);
    const cur = h.cachedParam(p.key);
    if (saved === undefined) {
      unknown.push(p.key);
      continue;
    }
    if (cur !== undefined && cur !== saved) writes.push({ key: p.key, from: cur, to: saved });
  }
  return { writes, unknown };
}
