import type { TracedFrame } from '../../core';
import { bytesHex, classLabel, idHex } from './ids';

export type TimeMode = 'abs' | 'rel' | 'delta';

/** `(1234.567890) can0 18080C41#0102`; CAN-FD uses `##` followed by the flag nibble (1 = BRS). */
export function candumpLine(f: Pick<TracedFrame, 't' | 'id' | 'data' | 'fd' | 'brs'>, iface = 'can0'): string {
  const ts = (f.t / 1000).toFixed(6);
  const data = bytesHex(f.data, '');
  const body = f.fd ? `${idHex(f.id)}##${f.brs ? '1' : '0'}${data}` : `${idHex(f.id)}#${data}`;
  return `(${ts}) ${iface} ${body}`;
}

export function toCandump(frames: Iterable<Pick<TracedFrame, 't' | 'id' | 'data' | 'fd' | 'brs'>>, iface = 'can0'): string {
  const lines: string[] = [];
  for (const f of frames) lines.push(candumpLine(f, iface));
  return lines.length ? `${lines.join('\n')}\n` : '';
}

export const frameTypeLabel = (f: Pick<TracedFrame, 'fd' | 'brs'>): string => (f.fd ? (f.brs ? 'FD·BRS' : 'FD') : 'CAN');

function csvCell(s: string): string {
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const CSV_HEADER = 'seq,time_s,dir,id,type,dlc,data,class,summary';

export function csvRow(f: TracedFrame, summary: string): string {
  return [
    String(f.seq),
    (f.t / 1000).toFixed(6),
    f.dir.toUpperCase(),
    `0x${idHex(f.id)}`,
    frameTypeLabel(f),
    String(f.data.length),
    bytesHex(f.data, ' '),
    classLabel(f.id),
    summary,
  ]
    .map(csvCell)
    .join(',');
}

export function toCsv(rows: Iterable<{ frame: TracedFrame; summary: string }>): string {
  const lines = [CSV_HEADER];
  for (const r of rows) lines.push(csvRow(r.frame, r.summary));
  return `${lines.join('\n')}\n`;
}

/** Interval between two frames: `+0.250 ms`, `+12.5 ms`, `+1.20 s`. */
export function fmtDelta(dtMs: number, decimal: (v: number, d: number) => string): string {
  const a = Math.abs(dtMs);
  const sign = dtMs < 0 ? '−' : '+';
  if (a < 1) return `${sign}${decimal(a, 3)} ms`;
  if (a < 1000) return `${sign}${decimal(a, a < 10 ? 2 : 1)} ms`;
  return `${sign}${decimal(a / 1000, 2)} s`;
}

/** Frame time for the time column. `ref` is the first kept frame (rel) or the previous row (delta). */
export function fmtFrameTime(mode: TimeMode, tMs: number, refMs: number | null, decimal: (v: number, d: number) => string): string {
  if (mode === 'abs') return decimal(tMs / 1000, 6);
  if (mode === 'rel') return decimal((tMs - (refMs ?? tMs)) / 1000, 6);
  return refMs === null ? '—' : fmtDelta(tMs - refMs, decimal);
}

/** `12.5 ms` / `100 Hz` for the by-id view. */
export function fmtPeriod(periodMs: number | null, decimal: (v: number, d: number) => string): string {
  if (periodMs === null) return '—';
  return periodMs >= 1000 ? `${decimal(periodMs / 1000, 2)} s` : `${decimal(periodMs, periodMs < 10 ? 2 : 1)} ms`;
}

export function fmtFreq(hz: number | null, decimal: (v: number, d: number) => string): string {
  if (hz === null) return '—';
  return hz >= 1000 ? `${decimal(hz / 1000, 2)} kHz` : `${decimal(hz, hz < 10 ? 2 : hz < 100 ? 1 : 0)} Hz`;
}
