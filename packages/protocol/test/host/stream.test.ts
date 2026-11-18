import { describe, expect, it } from 'vitest';
import { getModel, signalByKey } from '../../src/catalog/catalog';
import { BUS_LOAD_STREAM_LIMIT, Cls, Model, STREAM_MAX_SLOTS_CLASSIC, StreamReq } from '../../src/core/constants';
import { idClass, idIndex } from '../../src/core/id';
import { streamLoad } from '../../src/host/cycan/stream';
import type { DeviceHandle } from '../../src/host/types';
import { run } from '../helpers/fake-bus';
import { rig } from '../helpers/setup';

const ESC = getModel(Model.ESC_20A)!;
const sid = (k: string): number => signalByKey(ESC, k)!.sid;

async function escRig(fd: boolean) {
  const r = await rig({ fd });
  const n = r.node({ model: Model.ESC_20A, seed: 60 + (fd ? 0 : 1), num: 1, fd });
  const h = await r.ready(n);
  return { r, n, h };
}

describe('stream', () => {
  for (const fd of [true, false]) {
    it(`delivers samples in consumer order (${fd ? 'FD' : 'classic'})`, async () => {
      const { r, n, h } = await escRig(fd);
      const sub = h.stream.open({ signals: ['position', 'velocity', 'bus.voltage'], periodUs: 1000 });
      await run(r.sched, 0.5, 0.5);
      expect(n.streamSlots).toEqual([sid('position'), sid('velocity'), sid('bus.voltage')]);
      const rows: Array<{ t: number; v: number[] }> = [];
      sub.onData((t, v) => rows.push({ t, v: [...v] }));
      await run(r.sched, 50);
      expect(rows.length).toBeGreaterThanOrEqual(45);
      for (const row of rows) {
        const seq = row.v[0]! - sid('position') * 100;
        expect(row.v).toEqual([sid('position') * 100 + seq, sid('velocity') * 100 + seq, sid('bus.voltage') * 100 + seq]);
      }
      // Board timestamps map onto host time (zero latency on the fake wire).
      const last = rows.at(-1)!;
      expect(Math.abs(last.t - (r.sched.now() - 1))).toBeLessThanOrEqual(1.5);
      expect(sub.lost).toBe(0);
      expect(sub.periodUs).toBe(1000);
      sub.close();
    });
  }

  it('counts lost samples from seq gaps', async () => {
    const { r, n, h } = await escRig(false);
    n.streamSkip = (seq) => seq === 10 || seq === 11 || seq === 30;
    const sub = h.stream.open({ signals: ['duty'], periodUs: 1000 });
    await run(r.sched, 60);
    expect(sub.lost).toBe(3);
    expect(sub.samples).toBeGreaterThan(50);
  });

  it('emits incomplete classic samples with NaN for missing slots', async () => {
    const { r, n, h } = await escRig(false);
    const sub = h.stream.open({ signals: ['duty', 'velocity'], periodUs: 1000 });
    r.wire.drop = (f, from) => from === 'node' && idClass(f.id) === Cls.STREAM_RSP && f.data[0] === 20 && f.data[1] === 1;
    const rows: number[][] = [];
    sub.onData((_t, v) => rows.push([...v]));
    await run(r.sched, 40);
    const partial = rows.find((v) => Number.isNaN(v[1]));
    expect(partial?.[0]).toBe(sid('duty') * 100 + 20);
    expect(n.streaming).toBe(true);
  });

  it('keeps the stream alive and survives t_100us wrap-around', async () => {
    const { r, n, h } = await escRig(true);
    const sub = h.stream.open({ signals: ['velocity'], periodUs: 5000 });
    const times: number[] = [];
    sub.onData((t) => times.push(t));
    await run(r.sched, 15_000, 5);
    expect(n.streaming).toBe(true);
    const starts = r.wire.hostFrames().filter((f) => idClass(f.id) === Cls.STREAM_REQ && idIndex(f.id) === StreamReq.START);
    expect(starts.length).toBeGreaterThanOrEqual(15);
    for (let i = 1; i < times.length; i++) expect(times[i]! - times[i - 1]!).toBeCloseTo(5, 0);
    expect(times.at(-1)! - times[0]!).toBeGreaterThan(14_000);
  });

  it('shares slots between consumers and repacks on close', async () => {
    const { r, n, h } = await escRig(true);
    const a = h.stream.open({ signals: ['velocity', 'duty'], periodUs: 2000 });
    const b = h.stream.open({ signals: ['position', 'velocity'], periodUs: 1000 });
    expect(h.stream.slotsUsed).toBe(3);
    await run(r.sched, 0.5, 0.5);
    expect(n.streamSlots).toEqual([sid('velocity'), sid('duty'), sid('position')]);
    expect(a.periodUs).toBe(1000);
    let bRow: number[] = [];
    b.onData((_t, v) => (bRow = [...v]));
    await run(r.sched, 10);
    const seq = bRow[1]! - sid('velocity') * 100;
    expect(bRow).toEqual([sid('position') * 100 + seq, sid('velocity') * 100 + seq]);
    a.close();
    await run(r.sched, 3, 0.5);
    expect(n.streamSlots).toEqual([sid('velocity'), sid('position')]);
    await run(r.sched, 10);
    const seq2 = bRow[1]! - sid('velocity') * 100;
    expect(bRow).toEqual([sid('position') * 100 + seq2, sid('velocity') * 100 + seq2]);
    b.close();
    await run(r.sched, 5);
    expect(h.stream.active).toBe(false);
    expect(n.streaming).toBe(false);
  });

  it('rejects more than 15 slots with a typed error', async () => {
    const r = await rig();
    const n = r.node({ model: Model.SERVO_16CH, seed: 62, num: 1 });
    const h = await r.ready(n);
    const keys = h.def!.signals.map((s) => s.key);
    h.stream.open({ signals: keys.slice(0, 10), periodUs: 2000 });
    expect(() => h.stream.open({ signals: keys.slice(5, 16), periodUs: 2000 })).toThrow(expect.objectContaining({ code: 'NO_SLOTS' }));
    expect(() => h.stream.open({ signals: ['nope'], periodUs: 2000 })).toThrow(expect.objectContaining({ code: 'INVALID' }));
    expect(h.stream.slotsUsed).toBe(10);
  });

  it('reconfigures the board after it comes back', async () => {
    const { r, n, h } = await escRig(true);
    const sub = h.stream.open({ signals: ['velocity'], periodUs: 1000 });
    n.powerOff();
    await run(r.sched, 2000);
    expect(h.online).toBe(false);
    n.powerOn();
    await run(r.sched, 1500);
    expect(n.streamSlots).toEqual([sid('velocity')]);
    const before = sub.samples;
    await run(r.sched, 20);
    expect(sub.samples).toBeGreaterThan(before);
  });

  for (const fd of [true, false]) {
    it(`keeps the remaining consumer flowing with the right values when another closes (${fd ? 'FD' : 'classic'})`, async () => {
      const { r, n, h } = await escRig(fd);
      // CAN priority: CONFIG/START (INDEX 0/1) beat STOP (INDEX 2) when queued together.
      r.wire.delay = (f, from) => (from === 'host' && idClass(f.id) === Cls.STREAM_REQ && idIndex(f.id) === StreamReq.STOP ? 0.5 : 0);
      n.streamValue = (s) => s;
      const a = h.stream.open({ signals: ['velocity', 'setpoint'], periodUs: 1000 });
      const b = h.stream.open({ signals: ['phase.current'], periodUs: 1000 });
      const rows: Array<{ t: number; v: number }> = [];
      b.onData((t, v) => rows.push({ t, v: v[0]! }));
      await run(r.sched, 20, 0.5);
      a.close();
      await run(r.sched, 50, 0.5);
      for (const row of rows) expect(row.v).toBe(sid('phase.current'));
      let gap = 0;
      for (let i = 1; i < rows.length; i++) gap = Math.max(gap, rows[i]!.t - rows[i - 1]!.t);
      expect(gap).toBeLessThanOrEqual(4);
      expect(n.streaming).toBe(true);
      expect(n.streamSlots).toEqual([sid('phase.current')]);
    });
  }

  for (const outage of [100, 200, 400, 900]) {
    it(`counts ${outage} ms of missing samples and keeps every good one`, async () => {
      const { r, h } = await escRig(true);
      const sub = h.stream.open({ signals: ['velocity'], periodUs: 1000 });
      await run(r.sched, 50);
      const from = r.sched.now();
      r.wire.drop = (f, src) => src === 'node' && idClass(f.id) === Cls.STREAM_RSP && r.sched.now() >= from && r.sched.now() < from + outage;
      const before = sub.samples;
      await run(r.sched, outage + 300);
      const got = sub.samples - before;
      expect(Math.abs(sub.lost - outage)).toBeLessThanOrEqual(1);
      expect(got + sub.lost).toBeGreaterThanOrEqual(outage + 298);
    });
  }

  it('refuses a stream that would overload the bus, and more than 4 signals on classic CAN', async () => {
    const r = await rig();
    const boards = [0, 1, 2].map((i) => r.node({ model: Model.ESC_80A, seed: 330 + i, num: i + 1 }));
    const hs: DeviceHandle[] = [];
    for (const b of boards) hs.push(await r.ready(b));
    const all = ESC.signals.map((x) => x.key);
    const one = streamLoad(all.length, 1000, false);
    expect(one).toBeGreaterThan(0.25);
    hs[0]!.stream.open({ signals: all, periodUs: 1000 });
    hs[1]!.stream.open({ signals: all, periodUs: 1000 });
    expect(2 * one).toBeLessThan(BUS_LOAD_STREAM_LIMIT);
    expect(() => hs[2]!.stream.open({ signals: all, periodUs: 1000 })).toThrow(expect.objectContaining({ code: 'NO_BANDWIDTH' }));
    // Still refused once the load was measured, and accepted at a slower rate.
    await run(r.sched, 1100, 5);
    expect(() => hs[2]!.stream.open({ signals: all, periodUs: 1000 })).toThrow(expect.objectContaining({ code: 'NO_BANDWIDTH' }));
    expect(hs[2]!.stream.open({ signals: all, periodUs: 10_000 }).periodUs).toBe(10_000);

    const c = await rig({ fd: false });
    const cn = c.node({ model: Model.ESC_20A, seed: 333, num: 1, fd: false });
    const ch = await c.ready(cn);
    expect(() => ch.stream.open({ signals: all.slice(0, STREAM_MAX_SLOTS_CLASSIC + 1), periodUs: 5000 })).toThrow(
      expect.objectContaining({ code: 'NO_SLOTS', reason: 'classic_limit' }),
    );
    expect(ch.stream.open({ signals: all.slice(0, STREAM_MAX_SLOTS_CLASSIC), periodUs: 5000 }).signals).toHaveLength(4);
  });

  it('rebuilds a layout the board lost without a BOOT heartbeat (keepalive watchdog)', async () => {
    const { r, n, h } = await escRig(true);
    const sub = h.stream.open({ signals: ['velocity', 'duty'], periodUs: 2000 });
    await run(r.sched, 100);
    // The board restarts but its BOOT heartbeat is lost: only the stream notices.
    r.wire.drop = (f, from) => from === 'node' && idClass(f.id) === Cls.SYS_RSP && f.data[0] === 0;
    n.powerOff();
    n.powerOn();
    await run(r.sched, 600);
    r.wire.drop = null;
    await run(r.sched, 2200);
    const before = sub.samples;
    await run(r.sched, 100);
    expect(sub.samples - before).toBeGreaterThanOrEqual(45);
    expect(n.streamSlots).toEqual([sid('velocity'), sid('duty')]);
  });
});
