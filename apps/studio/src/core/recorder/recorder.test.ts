import { describe, expect, it } from 'vitest';
import type { DeviceHandle, SignalUpdate } from '@cygnus/protocol';
import { create } from 'zustand';
import { FrameTrace } from './frames';
import { SignalHistory } from './history';
import { SessionRecorder, type RecorderState } from './session';

function fakeDevice(uid48: string) {
  const listeners = new Set<(u: SignalUpdate) => void>();
  const values: Record<string, number> = {};
  return {
    handle: {
      uid48,
      getSignal: (k: string) => values[k] ?? NaN,
      onSignals: (cb: (u: SignalUpdate) => void) => {
        listeners.add(cb);
        return () => listeners.delete(cb);
      },
    } as unknown as DeviceHandle,
    listeners,
    emit(t: number, patch: Record<string, number>) {
      Object.assign(values, patch);
      for (const l of listeners) l({ t, frame: 0, keys: Object.keys(patch), values });
    },
  };
}

describe('FrameTrace', () => {
  it('keeps the newest frames when the ring wraps', () => {
    const tr = new FrameTrace(4);
    for (let i = 0; i < 10; i++) tr.push(i % 2 ? 'tx' : 'rx', { id: 0x100 + i, data: new Uint8Array([i, i + 1]), fd: false, brs: false, timestamp: i });
    expect(tr.length).toBe(4);
    expect(tr.totalSeen).toBe(10);
    const first = tr.get(0);
    expect(first?.id).toBe(0x106);
    expect(first?.seq).toBe(6);
    expect([...(first?.data ?? [])]).toEqual([6, 7]);
    expect(tr.get(3)?.id).toBe(0x109);
    expect(tr.dirAt(3)).toBe('tx');
    expect(tr.get(4)).toBeUndefined();
  });

  it('copies payloads (the source buffer may be reused) and clears', () => {
    const tr = new FrameTrace(8);
    const data = new Uint8Array(64).fill(7);
    tr.push('rx', { id: 1, data, fd: true, brs: true, timestamp: 0 });
    data.fill(0);
    const f = tr.get(0);
    expect(f?.data.length).toBe(64);
    expect(f?.data[63]).toBe(7);
    expect(f?.fd && f.brs).toBe(true);
    tr.clear();
    expect(tr.length).toBe(0);
  });
});

describe('SignalHistory', () => {
  it('records only while acquired and shares buffers per capacity', () => {
    const h = new SignalHistory();
    const dev = fakeDevice('a');
    h.setResolver(() => dev.handle);
    const a = h.acquire('a', 'v', 100);
    const b = h.acquire('a', 'v', 100);
    expect(a.buffer).toBe(b.buffer);
    dev.emit(1000, { v: 1 });
    dev.emit(2000, { v: 2, w: 9 });
    expect(a.buffer.length).toBe(2);
    expect(a.buffer.timeAt(1)).toBe(2);
    a.release();
    dev.emit(3000, { v: 3 });
    expect(b.buffer.length).toBe(3);
    b.release();
    expect(h.trackCount).toBe(0);
    expect(dev.listeners.size).toBe(0);
  });
});

describe('SessionRecorder', () => {
  it('exports wide CSV with sample-and-hold columns', () => {
    const store = create<RecorderState>(() => ({ recording: false, startedAt: null, stoppedAt: null, channels: [], samples: 0, statusFallback: [], lost: 0 }));
    const rec = new SessionRecorder(store, () => 0);
    const a = fakeDevice('a');
    const b = fakeDevice('b');
    rec.setResolver((uid) => (uid === 'a' ? a.handle : b.handle));
    rec.start([
      { uid48: 'a', key: 'vel', label: 'A vel', unit: 'rpm' },
      { uid48: 'b', key: 'cur', label: 'B, cur' },
    ]);
    a.emit(100, { vel: 10 });
    b.emit(110, { cur: 1.5 });
    a.emit(120, { vel: 12 });
    rec.stop();
    expect(store.getState().recording).toBe(false);
    expect(rec.sampleCount).toBe(3);
    const lines = rec.toCSV().trim().split('\n');
    expect(lines[0]).toBe('time_s,A vel [rpm],"B, cur"');
    expect(lines.slice(1)).toEqual(['0.0000,10,', '0.0100,10,1.5', '0.0200,12,1.5']);
    a.emit(130, { vel: 99 });
    expect(rec.sampleCount).toBe(3);
    const json = JSON.parse(rec.toJSON()) as { channels: Array<{ v: number[] }> };
    expect(json.channels[0]?.v).toEqual([10, 12]);
  });

  it('records high-rate stream samples and falls back to STATUS when no stream is possible', async () => {
    const store = create<RecorderState>(() => ({ recording: false, startedAt: null, stoppedAt: null, channels: [], samples: 0, statusFallback: [], lost: 0 }));
    const rec = new SessionRecorder(store, () => 0);
    let push: ((t: number, v: Float32Array) => void) | null = null;
    const closed: string[] = [];
    const streamDev = {
      uid48: 's',
      def: { signals: [{ key: 'vel' }, { key: 'cur' }] },
      capabilities: { stream: true },
      onSignals: () => () => undefined,
      stream: {
        open: (o: { signals: readonly string[]; periodUs: number }) => {
          expect(o).toEqual({ signals: ['vel', 'cur'], periodUs: 1000 });
          return {
            lost: 2,
            onData: (cb: (t: number, v: Float32Array) => void) => {
              push = cb;
              return () => (push = null);
            },
            close: () => closed.push('s'),
          };
        },
      },
    };
    const legacy = fakeDevice('l');
    rec.setResolver((uid) => (uid === 's' ? (streamDev as unknown as DeviceHandle) : legacy.handle));
    rec.start(
      [
        { uid48: 's', key: 'vel', label: '=cmd|calc' },
        { uid48: 's', key: 'cur' },
        { uid48: 'l', key: 'x' },
      ],
      { streamPeriodUs: 1000 },
    );
    expect(store.getState().statusFallback).toEqual(['l']);
    const emit = push as ((t: number, v: Float32Array) => void) | null;
    for (let i = 0; i < 5; i++) emit?.(1000 + i, new Float32Array([i, i * 10]));
    rec.stop();
    expect(closed).toEqual(['s']);
    expect(store.getState().lost).toBe(2);
    expect(rec.sampleCount).toBe(10);
    const csv = await rec.exportCSV();
    expect(csv).toBe(rec.toCSV());
    const lines = csv.trim().split('\n');
    // formula-looking titles are defused for spreadsheets (uygulama #14)
    expect(lines[0]).toBe("time_s,'=cmd|calc,s.cur,l.x");
    expect(lines).toHaveLength(6);
    expect(lines[5]).toBe('0.0040,4,40,');
    const json = JSON.parse(await rec.exportJSON({ note: 'x' })) as { note: string; channels: Array<{ t_ms: number[]; v: Array<number | null> }> };
    expect(json.note).toBe('x');
    expect(json.channels[1]?.v).toEqual([0, 10, 20, 30, 40]);
    expect(json.channels[2]?.v).toEqual([]);
  });
});

