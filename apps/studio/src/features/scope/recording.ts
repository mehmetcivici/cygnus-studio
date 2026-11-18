import { SeriesBuffer } from '../../ui';
import { MAX_PANES, defaultLayout, type ScopeLayout, type ScopeSignalCfg } from './layout';

export interface RecordedChannel {
  label: string;
  unit: string;
  /** Seconds from the start of the take. */
  t: number[];
  v: number[];
}

export interface ParsedRecording {
  channels: RecordedChannel[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseJson(text: string): ParsedRecording | null {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(doc) || doc.format !== 'cygnus-recording' || !Array.isArray(doc.channels)) return null;
  const channels: RecordedChannel[] = [];
  for (const c of doc.channels) {
    if (!isRecord(c) || !Array.isArray(c.t_ms) || !Array.isArray(c.v)) return null;
    const label = typeof c.label === 'string' ? c.label : `${String(c.uid48 ?? '')}.${String(c.key ?? '')}`;
    const unit = typeof c.unit === 'string' ? c.unit : '';
    const n = Math.min(c.t_ms.length, c.v.length);
    const t: number[] = [];
    const v: number[] = [];
    for (let i = 0; i < n; i++) {
      t.push(Number(c.t_ms[i]) / 1000);
      const x = c.v[i];
      v.push(typeof x === 'number' ? x : NaN);
    }
    channels.push({ label, unit, t, v });
  }
  return { channels };
}

/** Splits one CSV line (RFC 4180 quoting). */
export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else quoted = false;
      } else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

/** `Sol ön · velocity [rps]` → label and unit. */
export function splitTitle(title: string): { label: string; unit: string } {
  const m = /^(.*) \[([^\]]*)\]$/.exec(title);
  return m ? { label: m[1] ?? title, unit: m[2] ?? '' } : { label: title, unit: '' };
}

function parseCsv(text: string): ParsedRecording | null {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  const header = lines[0] ? splitCsvLine(lines[0]) : [];
  if (header[0] !== 'time_s' || header.length < 2) return null;
  const channels: RecordedChannel[] = header.slice(1).map((h) => ({ ...splitTitle(h), t: [], v: [] }));
  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i] ?? '');
    const t = Number(cells[0]);
    if (!Number.isFinite(t)) continue;
    channels.forEach((c, k) => {
      const cell = cells[k + 1];
      // An empty cell means "no value yet": skip it instead of drawing a hole.
      if (cell === undefined || cell === '') return;
      const v = Number(cell);
      if (Number.isFinite(v)) {
        c.t.push(t);
        c.v.push(v);
      }
    });
  }
  return { channels };
}

/** Reads a recording written by the session recorder (JSON or wide CSV); null when unrecognised. */
export function parseRecording(text: string): ParsedRecording | null {
  const trimmed = text.replace(/^﻿/, '').trimStart();
  const rec = trimmed.startsWith('{') ? parseJson(trimmed) : parseCsv(trimmed);
  return rec && rec.channels.length > 0 ? rec : null;
}

export interface StaticSession {
  name: string;
  layout: ScopeLayout;
  meta: Map<string, { label: string; unit: string }>;
  buffers: Map<string, SeriesBuffer>;
  /** First/last sample time over all channels. */
  extent: [number, number];
  samples: number;
}

/** Turns a recording into a chart workspace: one pane per distinct unit. */
export function buildStaticSession(name: string, rec: ParsedRecording): StaticSession {
  const units: string[] = [];
  for (const c of rec.channels) if (!units.includes(c.unit) && units.length < MAX_PANES) units.push(c.unit);
  const base = defaultLayout();
  const panes = units.map((_, i) => `p${i + 1}`);
  const signals: ScopeSignalCfg[] = [];
  const meta = new Map<string, { label: string; unit: string }>();
  const buffers = new Map<string, SeriesBuffer>();
  let lo = Infinity;
  let hi = -Infinity;
  let samples = 0;
  rec.channels.forEach((c, i) => {
    const id = `rec/${i}`;
    const buf = new SeriesBuffer(Math.max(2, c.t.length));
    // Wide-CSV holds can repeat a timestamp; keep order, drop nothing.
    for (let k = 0; k < c.t.length; k++) buf.push(c.t[k] ?? 0, c.v[k] ?? NaN);
    if (c.t.length) {
      lo = Math.min(lo, c.t[0] ?? lo);
      hi = Math.max(hi, c.t[c.t.length - 1] ?? hi);
    }
    samples += c.t.length;
    buffers.set(id, buf);
    meta.set(id, { label: c.label, unit: c.unit });
    const paneIdx = Math.max(0, units.indexOf(c.unit));
    signals.push({
      id,
      uid48: '',
      key: String(i),
      color: `chart-${(i % 8) + 1}`,
      axis: 'left',
      visible: true,
      pane: panes[Math.min(paneIdx, panes.length - 1)] ?? 'p1',
    });
  });
  const extent: [number, number] = Number.isFinite(lo) && hi > lo ? [lo, hi] : [0, 1];
  return { name, layout: { ...base, panes: panes.length ? panes : ['p1'], signals }, meta, buffers, extent, samples };
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** `cygnus-scope-20260412-153045.csv` */
export function recordingFileName(ext: 'csv' | 'json', now: Date = new Date()): string {
  const d = `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}`;
  const t = `${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`;
  return `cygnus-scope-${d}-${t}.${ext}`;
}
