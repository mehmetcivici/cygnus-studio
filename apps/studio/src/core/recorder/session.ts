import { create } from 'zustand';
import type { DeviceHandle, SignalUpdate, StreamSubscription } from '@cygnus/protocol';

export interface RecordChannel {
  uid48: string;
  key: string;
  /** Column title (e.g. `Sol ön · velocity`); defaults to `uid48.key`. */
  label?: string;
  unit?: string;
}

export interface RecordOptions {
  /**
   * Record from a high-rate stream (`d.stream.open`) at this period instead of STATUS updates.
   * Per board; boards whose stream cannot open (no slot, legacy) fall back to STATUS and are
   * listed in `RecorderState.statusFallback`.
   */
  streamPeriodUs?: number;
}

export interface RecorderState {
  /** Boards recorded from STATUS although a stream was requested. */
  statusFallback: readonly string[];
  /** Samples dropped by stream sequence gaps (0 for STATUS recordings). */
  lost: number;
  recording: boolean;
  startedAt: number | null;
  stoppedAt: number | null;
  channels: readonly RecordChannel[];
  samples: number;
}

export const useRecorder = create<RecorderState>(() => ({ recording: false, startedAt: null, stoppedAt: null, channels: [], samples: 0, statusFallback: [], lost: 0 }));

interface Column {
  ch: RecordChannel;
  t: number[];
  v: number[];
}

/** Hard ceiling so a forgotten recording cannot eat the machine's memory. */
export const RECORDER_MAX_SAMPLES = 5_000_000;

/**
 * Session recorder: every STATUS update of the chosen signals with its host timestamp, kept
 * until cleared; exports CSV (wide, sample-and-hold, one row per update) or JSON (per channel).
 */
export class SessionRecorder {
  private cols: Column[] = [];
  private offs: Array<() => void> = [];
  private subs: StreamSubscription[] = [];
  private resolve: (uid48: string) => DeviceHandle | undefined = () => undefined;
  private t0 = 0;
  private count = 0;
  private lastPublish = 0;

  constructor(
    private readonly store = useRecorder,
    private readonly now: () => number = () => Date.now(),
  ) {}

  setResolver(resolve: ((uid48: string) => DeviceHandle | undefined) | null): void {
    this.resolve = resolve ?? (() => undefined);
    // A different bus means a different timebase: end the take.
    if (this.store.getState().recording) this.stop();
  }

  /**
   * Starts a take. STATUS rate by default; `{ streamPeriodUs }` records every stream sample
   * (e.g. 1000 µs = 1 kHz) on boards that can stream those signals.
   */
  start(channels: readonly RecordChannel[], opts: RecordOptions = {}): void {
    this.stop();
    this.cols = channels.map((ch) => ({ ch, t: [], v: [] }));
    this.count = 0;
    this.t0 = NaN;
    const byUid = new Map<string, Column[]>();
    for (const c of this.cols) byUid.set(c.ch.uid48, [...(byUid.get(c.ch.uid48) ?? []), c]);
    const fallback: string[] = [];
    for (const [uid, cols] of byUid) {
      const h = this.resolve(uid);
      if (!h) continue;
      if (opts.streamPeriodUs !== undefined && this.openStream(h, cols, opts.streamPeriodUs)) continue;
      if (opts.streamPeriodUs !== undefined) fallback.push(uid);
      this.offs.push(h.onSignals((u) => this.onUpdate(cols, u)));
    }
    this.store.setState({ recording: true, startedAt: this.now(), stoppedAt: null, channels: [...channels], samples: 0, statusFallback: fallback, lost: 0 });
  }

  private openStream(h: DeviceHandle, cols: Column[], periodUs: number): boolean {
    const streamable = new Set((h.def?.signals ?? []).map((s) => s.key));
    const keys = [...new Set(cols.map((c) => c.ch.key))];
    if (!h.capabilities?.stream || !keys.every((k) => streamable.has(k))) return false;
    let sub: StreamSubscription;
    try {
      sub = h.stream.open({ signals: keys, periodUs });
    } catch {
      return false;
    }
    const index = cols.map((c) => keys.indexOf(c.ch.key));
    this.subs.push(sub);
    this.offs.push(
      sub.onData((t, values) => {
        if (this.count >= RECORDER_MAX_SAMPLES) {
          this.stop();
          return;
        }
        if (Number.isNaN(this.t0)) this.t0 = t;
        cols.forEach((c, i) => {
          c.t.push(t - this.t0);
          c.v.push(values[index[i] ?? 0] ?? NaN);
        });
        this.count += cols.length;
        this.publishSoon();
      }),
    );
    return true;
  }

  stop(): void {
    for (const off of this.offs.splice(0)) off();
    const lost = this.subs.reduce((n, s) => n + s.lost, 0);
    for (const s of this.subs.splice(0)) s.close();
    if (this.store.getState().recording) this.store.setState({ recording: false, stoppedAt: this.now(), samples: this.count, lost });
  }

  clear(): void {
    this.stop();
    this.cols = [];
    this.count = 0;
    this.store.setState({ startedAt: null, stoppedAt: null, channels: [], samples: 0 });
  }

  get sampleCount(): number {
    return this.count;
  }

  private onUpdate(cols: Column[], u: SignalUpdate): void {
    if (this.count >= RECORDER_MAX_SAMPLES) {
      this.stop();
      return;
    }
    if (Number.isNaN(this.t0)) this.t0 = u.t;
    for (const c of cols) {
      if (!u.keys.includes(c.ch.key)) continue;
      c.t.push(u.t - this.t0);
      c.v.push(u.values[c.ch.key] ?? NaN);
      this.count++;
    }
    this.publishSoon();
  }

  // Sample counter for the status bar: a few updates per second are plenty.
  private publishSoon(): void {
    const n = this.now();
    if (n - this.lastPublish > 250) {
      this.lastPublish = n;
      this.store.setState({ samples: this.count, lost: this.subs.reduce((k, s) => k + s.lost, 0) });
    }
  }

  /** Wide CSV: `time_s` then one column per channel; a cell holds that channel's latest value. */
  toCSV(): string {
    let out = '';
    for (const part of this.csvParts(Infinity)) out += part;
    return out;
  }

  /**
   * Same as `toCSV` but yields to the event loop every few thousand rows, so E-STOP and the
   * control loop stay responsive while a long take is exported (5 M samples ≈ 1 s of work).
   */
  async exportCSV(): Promise<string> {
    const parts: string[] = [];
    for (const part of this.csvParts(CHUNK_ROWS)) {
      parts.push(part);
      await yieldToLoop();
    }
    return parts.join('');
  }

  /** JSON export with the same yielding as `exportCSV`. */
  async exportJSON(meta: Record<string, unknown> = {}): Promise<string> {
    const head = JSON.stringify({ format: 'cygnus-recording', version: 1, startedAt: new Date(this.store.getState().startedAt ?? this.now()).toISOString(), ...meta });
    const parts: string[] = [head.slice(0, -1), ',"channels":['];
    for (let k = 0; k < this.cols.length; k++) {
      const c = this.cols[k];
      if (!c) continue;
      parts.push(k ? ',' : '', JSON.stringify({ ...c.ch }).slice(0, -1), ',"t_ms":[');
      for (let i = 0; i < c.t.length; i += CHUNK_ROWS) {
        parts.push((i ? ',' : '') + c.t.slice(i, i + CHUNK_ROWS).join(','));
        await yieldToLoop();
      }
      parts.push('],"v":[');
      for (let i = 0; i < c.v.length; i += CHUNK_ROWS) {
        parts.push((i ? ',' : '') + c.v.slice(i, i + CHUNK_ROWS).map((x) => (Number.isFinite(x) ? String(x) : 'null')).join(','));
        await yieldToLoop();
      }
      parts.push(']}');
    }
    parts.push(']}');
    return parts.join('');
  }

  private *csvParts(rowsPerPart: number): Generator<string> {
    const header = ['time_s', ...this.cols.map((c) => csvCell(columnTitle(c.ch)))].join(',');
    const idx = this.cols.map(() => 0);
    const last = this.cols.map(() => '');
    let lines = [header];
    for (;;) {
      let tMin = Infinity;
      this.cols.forEach((c, i) => {
        const t = c.t[idx[i] ?? 0];
        if (t !== undefined && t < tMin) tMin = t;
      });
      if (tMin === Infinity) break;
      this.cols.forEach((c, i) => {
        let j = idx[i] ?? 0;
        while (c.t[j] === tMin) {
          const v = c.v[j] ?? NaN;
          last[i] = Number.isFinite(v) ? String(v) : '';
          j++;
        }
        idx[i] = j;
      });
      lines.push([(tMin / 1000).toFixed(4), ...last].join(','));
      if (lines.length >= rowsPerPart) {
        yield lines.join('\n') + '\n';
        lines = [];
      }
    }
    if (lines.length) yield lines.join('\n') + '\n';
  }

  toJSON(meta: Record<string, unknown> = {}): string {
    return JSON.stringify(
      {
        format: 'cygnus-recording',
        version: 1,
        startedAt: new Date(this.store.getState().startedAt ?? this.now()).toISOString(),
        ...meta,
        channels: this.cols.map((c) => ({ ...c.ch, t_ms: c.t, v: c.v.map((x) => (Number.isFinite(x) ? x : null)) })),
      },
      null,
      1,
    );
  }
}

function columnTitle(ch: RecordChannel): string {
  const base = ch.label ?? `${ch.uid48}.${ch.key}`;
  return ch.unit ? `${base} [${ch.unit}]` : base;
}

const CHUNK_ROWS = 20_000;

function yieldToLoop(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

/** Quotes as needed and defuses spreadsheet formulas (`=`, `+`, `-`, `@`, tab, CR) in text cells. */
export function csvCell(s: string): string {
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export const sessionRecorder = new SessionRecorder();
