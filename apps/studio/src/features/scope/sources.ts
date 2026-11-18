import { CyError, STREAM_SLOTS, type CygnusBus, type StreamSubscription } from '@cygnus/protocol';
import { signalHistory } from '../../core';
import { SeriesBuffer } from '../../ui';
import type { ScopeMode } from './layout';

/** ~5 min at a 100 Hz STATUS rate. */
export const NORMAL_CAPACITY = 30_000;
const STREAM_MAX_SAMPLES = 300_000;

/** Ring size for a stream: five minutes of samples, bounded to keep memory sane. */
export function streamCapacity(periodUs: number): number {
  return Math.min(STREAM_MAX_SAMPLES, Math.max(4096, Math.ceil(300e6 / Math.max(100, periodUs))));
}

export interface SourceIssue {
  kind: 'noSlots' | 'unsupported' | 'failed';
  uid48: string;
  /** Slots needed (noSlots) or error text (failed). */
  detail: string;
}

export interface WantedSignal {
  id: string;
  uid48: string;
  key: string;
}

interface Entry {
  sig: string;
  dispose: () => void;
  issues: SourceIssue[];
  periodUs?: number;
  uid48?: string;
}

const busIds = new WeakMap<object, number>();
let busCounter = 0;
function busSig(bus: CygnusBus | null): number {
  if (!bus) return 0;
  let id = busIds.get(bus);
  if (!id) busIds.set(bus, (id = ++busCounter));
  return id;
}

/**
 * Owns the sample sources of the plotted signals. Normal mode shares the core's STATUS
 * history rings; high-speed mode opens one stream per board and fills private rings. `sync`
 * is incremental: untouched signals keep their buffers (and their history) when the layout
 * changes.
 */
export class SourceManager {
  readonly buffers = new Map<string, SeriesBuffer>();
  issues: SourceIssue[] = [];
  /** Period each board actually streams at, µs (shared streams run at the fastest request). */
  periods = new Map<string, number>();
  private entries = new Map<string, Entry>();

  constructor(private readonly onChange: () => void) {}

  sync(wanted: readonly WantedSignal[], mode: ScopeMode, periodUs: number, bus: CygnusBus | null): void {
    const plan = new Map<string, { sig: string; items: WantedSignal[]; make: (items: WantedSignal[]) => Entry }>();
    if (mode === 'normal') {
      for (const w of wanted) plan.set(w.id, { sig: `h`, items: [w], make: (items) => this.history(items) });
    } else {
      const byCard = new Map<string, WantedSignal[]>();
      for (const w of wanted) byCard.set(w.uid48, [...(byCard.get(w.uid48) ?? []), w]);
      for (const [uid, items] of byCard) {
        const sig = `s|${periodUs}|${busSig(bus)}|${items.map((i) => i.key).sort().join(',')}`;
        plan.set(`card:${uid}`, { sig, items, make: (its) => this.stream(uid, its, periodUs, bus) });
      }
    }
    for (const [key, e] of this.entries) {
      const p = plan.get(key);
      if (!p || p.sig !== e.sig) {
        e.dispose();
        this.entries.delete(key);
      }
    }
    for (const [key, p] of plan) if (!this.entries.has(key)) this.entries.set(key, { ...p.make(p.items), sig: p.sig });
    // Drop buffers of signals that are gone.
    const ids = new Set(wanted.map((w) => w.id));
    for (const id of [...this.buffers.keys()]) if (!ids.has(id)) this.buffers.delete(id);
    this.issues = [...this.entries.values()].flatMap((e) => e.issues);
    this.periods = new Map([...this.entries.values()].flatMap((e) => (e.uid48 && e.periodUs ? [[e.uid48, e.periodUs] as const] : [])));
    this.onChange();
  }

  dispose(): void {
    for (const e of this.entries.values()) e.dispose();
    this.entries.clear();
    this.buffers.clear();
    this.issues = [];
  }

  private history(items: readonly WantedSignal[], issues: SourceIssue[] = []): Entry {
    const releases = items.map((w) => {
      const h = signalHistory.acquire(w.uid48, w.key, NORMAL_CAPACITY);
      this.buffers.set(w.id, h.buffer);
      return h.release;
    });
    return { sig: '', issues, dispose: () => releases.forEach((r) => r()) };
  }

  private stream(uid: string, items: WantedSignal[], periodUs: number, bus: CygnusBus | null): Entry {
    const handle = bus?.deviceByUid(uid);
    // A board that is not (yet) on the bus is simply plotted at STATUS rate until it appears.
    if (!handle) return this.history(items);
    if (!handle.capabilities.stream) return this.history(items, [{ kind: 'unsupported', uid48: uid, detail: '' }]);
    if (items.length > STREAM_SLOTS) {
      return this.history(items, [{ kind: 'noSlots', uid48: uid, detail: String(items.length) }]);
    }
    let sub: StreamSubscription;
    try {
      sub = handle.stream.open({ signals: items.map((i) => i.key), periodUs });
    } catch (e) {
      const noSlots = e instanceof CyError && e.code === 'NO_SLOTS';
      return this.history(items, [{ kind: noSlots ? 'noSlots' : 'failed', uid48: uid, detail: noSlots ? String(items.length) : (e instanceof Error ? e.message : String(e)) }]);
    }
    const cap = streamCapacity(sub.periodUs);
    const bufs = items.map((w) => {
      const b = new SeriesBuffer(cap);
      this.buffers.set(w.id, b);
      return b;
    });
    const off = sub.onData((t, v) => {
      const ts = t / 1000;
      for (let k = 0; k < bufs.length; k++) bufs[k]?.push(ts, v[k] ?? NaN);
    });
    return {
      sig: '',
      issues: [],
      periodUs: sub.periodUs,
      uid48: uid,
      dispose: () => {
        off();
        sub.close();
      },
    };
  }
}
