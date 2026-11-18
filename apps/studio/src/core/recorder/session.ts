import { create } from 'zustand';
import type { DeviceHandle, SignalUpdate } from '@cygnus/protocol';

export interface RecordChannel {
  uid48: string;
  key: string;
  /** Column title (e.g. `Sol ön · velocity`); defaults to `uid48.key`. */
  label?: string;
  unit?: string;
}

export interface RecorderState {
  recording: boolean;
  startedAt: number | null;
  stoppedAt: number | null;
  channels: readonly RecordChannel[];
  samples: number;
}

export const useRecorder = create<RecorderState>(() => ({ recording: false, startedAt: null, stoppedAt: null, channels: [], samples: 0 }));

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

  start(channels: readonly RecordChannel[]): void {
    this.stop();
    this.cols = channels.map((ch) => ({ ch, t: [], v: [] }));
    this.count = 0;
    this.t0 = NaN;
    const byUid = new Map<string, Column[]>();
    for (const c of this.cols) byUid.set(c.ch.uid48, [...(byUid.get(c.ch.uid48) ?? []), c]);
    for (const [uid, cols] of byUid) {
      const h = this.resolve(uid);
      if (h) this.offs.push(h.onSignals((u) => this.onUpdate(cols, u)));
    }
    this.store.setState({ recording: true, startedAt: this.now(), stoppedAt: null, channels: [...channels], samples: 0 });
  }

  stop(): void {
    for (const off of this.offs.splice(0)) off();
    if (this.store.getState().recording) this.store.setState({ recording: false, stoppedAt: this.now(), samples: this.count });
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
    // Sample counter for the status bar: a few updates per second are plenty.
    const n = this.now();
    if (n - this.lastPublish > 250) {
      this.lastPublish = n;
      this.store.setState({ samples: this.count });
    }
  }

  /** Wide CSV: `time_s` then one column per channel; a cell holds that channel's latest value. */
  toCSV(): string {
    const header = ['time_s', ...this.cols.map((c) => csvCell(columnTitle(c.ch)))].join(',');
    const idx = this.cols.map(() => 0);
    const last = this.cols.map(() => '');
    const lines = [header];
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
    }
    return lines.join('\n') + '\n';
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

function csvCell(s: string): string {
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const sessionRecorder = new SessionRecorder();
