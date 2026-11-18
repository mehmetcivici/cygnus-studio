import { useEffect, useState } from 'react';
import type { DeviceHandle, SignalUpdate } from '@cygnus/protocol';
import { SeriesBuffer } from '../../ui';

/** Default history per (board, signal): ~60 s at 50 Hz STATUS. */
export const HISTORY_CAPACITY = 3000;

/** One ring per requested capacity, so a long Plot history never resizes a tile's buffer. */
interface Track {
  buffers: Map<number, { buffer: SeriesBuffer; refs: number }>;
}

interface Tap {
  handle: DeviceHandle | null;
  off: (() => void) | null;
  tracks: Map<string, Track>;
}

/**
 * Ring buffers of STATUS-rate signal values, created on demand and kept while referenced.
 * Times are host seconds (`SignalUpdate.t / 1000`), the same timebase as `LiveChart`.
 */
export class SignalHistory {
  private readonly taps = new Map<string, Tap>();
  private resolve: (uid48: string) => DeviceHandle | undefined = () => undefined;

  setResolver(resolve: ((uid48: string) => DeviceHandle | undefined) | null): void {
    this.resolve = resolve ?? (() => undefined);
    for (const [uid, tap] of this.taps) {
      this.retap(uid, tap);
      // A new bus restarts host time; old samples would draw backwards.
      for (const t of tap.tracks.values()) for (const b of t.buffers.values()) b.buffer.clear();
    }
  }

  deviceAvailable(uid48: string): void {
    const tap = this.taps.get(uid48);
    if (tap && tap.handle !== this.resolve(uid48)) this.retap(uid48, tap);
  }

  /**
   * Starts (or shares) the history of one signal. Call `release` when done; the buffer is
   * dropped with its last user. A larger `capacity` than the existing one re-allocates.
   */
  acquire(uid48: string, key: string, capacity = HISTORY_CAPACITY): { buffer: SeriesBuffer; release: () => void } {
    let tap = this.taps.get(uid48);
    if (!tap) {
      tap = { handle: null, off: null, tracks: new Map() };
      this.taps.set(uid48, tap);
    }
    let track = tap.tracks.get(key);
    if (!track) {
      track = { buffers: new Map() };
      tap.tracks.set(key, track);
    }
    let slot = track.buffers.get(capacity);
    if (!slot) {
      slot = { buffer: new SeriesBuffer(capacity), refs: 0 };
      track.buffers.set(capacity, slot);
    }
    slot.refs++;
    if (!tap.off) this.retap(uid48, tap);
    let released = false;
    const t = tap;
    const tr = track;
    const sl = slot;
    return {
      buffer: slot.buffer,
      release: () => {
        if (released) return;
        released = true;
        if (--sl.refs > 0) return;
        tr.buffers.delete(capacity);
        if (tr.buffers.size === 0 && t.tracks.get(key) === tr) t.tracks.delete(key);
        if (t.tracks.size === 0) {
          t.off?.();
          t.off = null;
          this.taps.delete(uid48);
        }
      },
    };
  }

  /** Existing buffer without taking a reference (null when nobody records it). */
  peek(uid48: string, key: string): SeriesBuffer | null {
    let best: SeriesBuffer | null = null;
    for (const { buffer } of this.taps.get(uid48)?.tracks.get(key)?.buffers.values() ?? []) {
      if (!best || buffer.capacity > best.capacity) best = buffer;
    }
    return best;
  }

  get trackCount(): number {
    let n = 0;
    for (const t of this.taps.values()) for (const tr of t.tracks.values()) n += tr.buffers.size;
    return n;
  }

  private retap(uid48: string, tap: Tap): void {
    tap.off?.();
    tap.off = null;
    const h = this.resolve(uid48) ?? null;
    tap.handle = h;
    if (h) tap.off = h.onSignals((u) => this.onUpdate(tap, u));
  }

  private onUpdate(tap: Tap, u: SignalUpdate): void {
    const t = u.t / 1000;
    for (const key of u.keys) {
      const tr = tap.tracks.get(key);
      if (!tr) continue;
      const v = u.values[key] ?? NaN;
      for (const b of tr.buffers.values()) b.buffer.push(t, v);
    }
  }
}

export const signalHistory = new SignalHistory();

/** History buffer of one signal for this component's lifetime (null until mounted / no uid). */
export function useSignalHistory(uid48: string | null | undefined, key: string | null | undefined, capacity = HISTORY_CAPACITY): SeriesBuffer | null {
  const [buffer, setBuffer] = useState<SeriesBuffer | null>(null);
  useEffect(() => {
    if (!uid48 || !key) {
      setBuffer(null);
      return;
    }
    const h = signalHistory.acquire(uid48, key, capacity);
    setBuffer(h.buffer);
    return () => {
      h.release();
      setBuffer(null);
    };
  }, [uid48, key, capacity]);
  return buffer;
}

/** Last `points` values of a signal, refreshed at `hz` (for StatTile/Sparkline trends). */
export function useTrend(uid48: string | null | undefined, key: string | null | undefined, points = 48, hz = 4): number[] {
  const buffer = useSignalHistory(uid48, key, Math.max(points, 64));
  const [values, setValues] = useState<number[]>([]);
  useEffect(() => {
    if (!buffer) {
      setValues([]);
      return;
    }
    let version = -1;
    const read = (): void => {
      if (buffer.version === version) return;
      version = buffer.version;
      const n = Math.min(points, buffer.length);
      const out = new Array<number>(n);
      for (let i = 0; i < n; i++) out[i] = buffer.valueAt(buffer.length - n + i);
      setValues(out);
    };
    read();
    const h = setInterval(read, 1000 / hz);
    return () => clearInterval(h);
  }, [buffer, points, hz]);
  return values;
}
