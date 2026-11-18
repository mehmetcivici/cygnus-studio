import { BROADCAST_ALL, CygnusBus, DevType, FaultBit, ManualScheduler, Timing, encodeEnumReq, encodeFaultReq, makeTxFrame } from '@cygnus/protocol';
import { describe, expect, it } from 'vitest';
import { SimBus, frameTimeUs, type BusEndpoint, type BusFrame } from '../src/bus';
import { CyncoderNode } from '../src/devices/cyncoder';
import { Prng } from '../src/prng';
import { RealtimeRunner } from '../src/runner';
import { createScenario } from '../src/scenarios';
import { Simulation } from '../src/simulation';
import { Host } from './helpers';

class Ep implements BusEndpoint {
  readonly got: Array<{ id: number; t: number; data: number[] }> = [];
  errors = 0;
  receive(f: BusFrame): void {
    this.got.push({ id: f.id, t: f.timestamp, data: [...f.data.subarray(0, f.len)] });
  }
  txError(): void {
    this.errors++;
  }
}

function busWith(n: number, o: { fd?: boolean } = {}): { bus: SimBus; eps: Ep[] } {
  const bus = new SimBus(new Prng(1), o);
  const eps = Array.from({ length: n }, () => new Ep());
  for (const e of eps) bus.attach(e);
  return { bus, eps };
}

const d8 = new Uint8Array(8);

describe('SimBus', () => {
  it('delivers in id priority order with increasing timestamps, never to the sender', () => {
    const { bus, eps } = busWith(2);
    bus.transmit(eps[0]!, 0x300, d8, 8, false, false);
    bus.transmit(eps[0]!, 0x100, d8, 8, false, false);
    bus.transmit(eps[0]!, 0x200, d8, 8, false, false);
    bus.step(0, 1);
    expect(eps[1]!.got.map((g) => g.id)).toEqual([0x100, 0x200, 0x300]);
    expect(eps[0]!.got).toHaveLength(0);
    const t = eps[1]!.got.map((g) => g.t);
    expect(t[0]).toBeCloseTo(frameTimeUs(8, false, false, 1e6, 0) / 1000, 6);
    expect(t[2]! > t[1]! && t[1]! > t[0]!).toBe(true);
  });

  it('estimates wire time and carries what does not fit to the next step', () => {
    expect(frameTimeUs(8, false, false, 1e6, 0)).toBeGreaterThan(125);
    expect(frameTimeUs(64, true, true, 1e6, 2e6)).toBeLessThan(frameTimeUs(64, true, false, 1e6, 2e6));
    const { bus, eps } = busWith(2);
    for (let i = 0; i < 12; i++) bus.transmit(eps[0]!, 0x100 + i, d8, 8, false, false);
    bus.step(0, 1);
    const first = eps[1]!.got.length;
    expect(first).toBeLessThan(12);
    bus.step(1, 1);
    expect(eps[1]!.got.length).toBe(12);
    for (let k = 0; k < 2000; k++) {
      for (let i = 0; i < 7; i++) bus.transmit(eps[0]!, 0x100 + i, d8, 8, false, false);
      bus.step(2 + k, 1);
    }
    expect(bus.stats.load).toBeGreaterThan(0.85);
  });

  it('loses the configured fraction of frames', () => {
    const { bus, eps } = busWith(2);
    bus.lossRate = 0.3;
    for (let k = 0; k < 1000; k++) {
      bus.transmit(eps[0]!, 0x100, d8, 8, false, false);
      bus.step(k, 1);
    }
    expect(eps[1]!.got.length).toBeGreaterThan(620);
    expect(eps[1]!.got.length).toBeLessThan(780);
    expect(bus.stats.lostFrames).toBe(1000 - eps[1]!.got.length);
  });

  it('unplugged endpoints neither send nor hear; a short kills everything', () => {
    const { bus, eps } = busWith(3);
    bus.setConnected(eps[2]!, false);
    expect(bus.transmit(eps[2]!, 0x1, d8, 8, false, false)).toBe(false);
    bus.transmit(eps[0]!, 0x2, d8, 8, false, false);
    bus.step(0, 1);
    expect(eps[1]!.got).toHaveLength(1);
    expect(eps[2]!.got).toHaveLength(0);
    bus.shorted = true;
    bus.transmit(eps[0]!, 0x3, d8, 8, false, false);
    bus.step(1, 1);
    expect(eps[1]!.got).toHaveLength(1);
    expect(eps[0]!.errors).toBe(1);
  });

  it('identical ids with different data: the dominant payload wins, the other sees an error', () => {
    const { bus, eps } = busWith(3);
    bus.transmit(eps[0]!, 0x50, Uint8Array.of(2), 1, false, false);
    bus.transmit(eps[1]!, 0x50, Uint8Array.of(1), 1, false, false);
    bus.step(0, 1);
    expect(eps[2]!.got.map((g) => g.data[0])).toEqual([1]);
    expect(eps[0]!.errors).toBe(1);
    expect(eps[1]!.errors).toBe(0);
  });

  it('FD frames on a classic-only bus become error frames', () => {
    const { bus, eps } = busWith(2, { fd: false });
    bus.transmit(eps[0]!, 0x60, new Uint8Array(12), 12, true, true);
    bus.step(0, 1);
    expect(eps[1]!.got).toHaveLength(0);
    expect(bus.stats.errorFrames).toBe(1);
  });
});

describe('SimBus transmit queues (host-sim #6)', () => {
  it('each endpoint overflows on its own: a babbling board cannot crowd out another sender', () => {
    const { bus, eps } = busWith(3);
    const [babbler, host, rx] = eps as [Ep, Ep, Ep];
    let accepted = 0;
    for (let i = 0; i < 2000; i++) if (bus.transmit(babbler, 0x1f08ffff, d8, 8, false, false)) accepted++;
    expect(accepted).toBe(256);
    expect(bus.stats.txOverflow).toBe(2000 - 256);
    expect(bus.transmit(host, 0x0008_1dc0, d8, 2, false, false)).toBe(true); // ESTOP-like broadcast
    bus.step(0, 1);
    expect(rx.got[0]!.id).toBe(0x0008_1dc0);
  });

  it('a full queue gives way to a higher-priority frame by dropping its own lowest-priority one', () => {
    const { bus, eps } = busWith(2);
    const [tx, rx] = eps as [Ep, Ep];
    for (let i = 0; i < 256; i++) expect(bus.transmit(tx, 0x02000000 + i, d8, 8, false, false)).toBe(true);
    expect(bus.transmit(tx, 0x03000000, d8, 8, false, false)).toBe(false); // ranks below all of them
    expect(bus.transmit(tx, 0x00080000, d8, 8, false, false)).toBe(true);
    expect(bus.queued).toBe(256);
    for (let t = 0; t < 100; t++) bus.step(t, 1);
    const ids = rx.got.map((g) => g.id);
    expect(ids[0]).toBe(0x00080000);
    expect(ids).not.toContain(0x02000000 + 255); // the one that was displaced
    expect(ids).toHaveLength(256);
  });
});

describe('RealtimeRunner in a background tab (host-sim #8)', () => {
  it('1 Hz timers: the simulation keeps pace and no board is taken for lost', async () => {
    const sim = createScenario('bench.arm');
    const sched = new ManualScheduler(0);
    const bus = new CygnusBus(sim.createTransport(), sched, {});
    await bus.start();
    const fg = new RealtimeRunner(sim, sched, { tickMs: 4 });
    fg.start();
    const run = async (ms: number, step: number): Promise<void> => {
      for (let t = 0; t < ms; t += step) {
        sched.advance(step);
        for (let i = 0; i < 5; i++) await Promise.resolve();
      }
    };
    await run(3000, 4);
    expect(bus.devices.filter((d) => d.online)).toHaveLength(sim.nodes.length);
    let lost = 0;
    bus.on('deviceLost', () => lost++);
    fg.stop();
    const bg = new RealtimeRunner(sim, sched, { tickMs: 1000 });
    bg.start();
    const t0 = sim.timeMs;
    await run(10_000, 1000);
    expect(sim.timeMs - t0).toBeGreaterThanOrEqual(9990);
    expect(bg.droppedMs).toBe(0);
    expect(lost).toBe(0);
    bg.stop();
    await bus.stop();
  });

  it('after a stall longer than the catch-up limit, frame stamps still end at the host clock', () => {
    const sim = createScenario('bench.flywheel');
    const sched = new ManualScheduler(0);
    const t = sim.createTransport();
    void t.open();
    const stamps: number[] = [];
    t.onFrame((f) => stamps.push(f.timestamp));
    // The browser holds the first timer back by 10 s.
    let lag = 10_000;
    const laggy = {
      now: () => sched.now(),
      setTimeout: (fn: () => void, ms: number) => {
        const h = sched.setTimeout(fn, ms + lag);
        lag = 0;
        return h;
      },
      clearTimeout: (h: unknown) => sched.clearTimeout(h),
    };
    const runner = new RealtimeRunner(sim, laggy, { tickMs: 4 });
    runner.start();
    sched.advance(10_004);
    expect(runner.droppedMs).toBeGreaterThan(10_000 - Timing.LOST_AFTER_MS - 600);
    // Heartbeats of the caught-up stretch are stamped within it, the last ones just before now.
    expect(stamps.at(-1)!).toBeLessThanOrEqual(sched.now());
    expect(stamps.at(-1)!).toBeGreaterThan(sched.now() - Timing.HEARTBEAT_MS - 60);
    expect(stamps[0]!).toBeGreaterThanOrEqual(sched.now() - Timing.LOST_AFTER_MS - 600);
    runner.stop();
  });
});

describe('simulation-level bus faults', () => {
  it('boards flag CAN_ERR while the bus is shorted and recover after', () => {
    const sim = new Simulation({ seed: 1 });
    const enc = sim.addNode(new CyncoderNode({ id: 'e', num: 1 }));
    const host = new Host(sim);
    host.run(500);
    sim.setBusShort(true);
    host.clear();
    host.run(600);
    expect(host.rx).toHaveLength(0);
    // A warning, as in the C library: the board keeps working, the host sees why frames went missing.
    expect(enc.faults.warn & (1 << FaultBit.CAN_ERR)).not.toBe(0);
    sim.setBusShort(false);
    host.run(10);
    const f = host.ask(encodeFaultReq({ devType: DevType.ENCODER, num: 1 }), 'faultRsp')[0]!;
    expect(f.warn & (1 << FaultBit.CAN_ERR)).toBe(0);
    expect(f.sticky & (1 << FaultBit.CAN_ERR)).not.toBe(0);
  });

  it('a pulled cable hides a board; the host transport timestamps on its clock', () => {
    const sim = new Simulation({ seed: 1 });
    sim.addNode(new CyncoderNode({ id: 'e', num: 1 }));
    const host = new Host(sim);
    host.run(500);
    sim.setCable('e', false);
    expect(host.ask(encodeEnumReq(BROADCAST_ALL, { filter: 0 }), 'enumRsp', 150)).toHaveLength(0);
    sim.setCable('e', true);
    expect(host.ask(encodeEnumReq(BROADCAST_ALL, { filter: 0 }), 'enumRsp', 150)).toHaveLength(1);
    expect(host.transport.info.kind).toBe('sim');
    host.send(makeTxFrame(0x1fffffff + 1, d8)); // invalid id is ignored
  });
});

describe('RealtimeRunner', () => {
  it('follows the scheduler clock and drops time beyond the catch-up limit', () => {
    const sched = new ManualScheduler(1000);
    const sim = new Simulation({ seed: 1 });
    sim.addNode(new CyncoderNode({ id: 'e', num: 1, uid96: new Prng(3).bytes(12) }));
    const runner = new RealtimeRunner(sim, sched, { tickMs: 5, maxCatchUpMs: 100 });
    const t = sim.createTransport();
    void t.open();
    const stamps: number[] = [];
    t.onFrame((f) => stamps.push(f.timestamp));
    runner.start();
    sched.advance(1000);
    expect(sim.timeMs).toBeGreaterThanOrEqual(995);
    expect(stamps.length).toBeGreaterThan(0);
    expect(stamps.at(-1)!).toBeLessThanOrEqual(sched.now() + 1);
    expect(stamps.at(-1)!).toBeGreaterThan(sched.now() - 20);
    runner.stop();
    // A background tab: the browser holds the next timer back by 5 s.
    let lag = 5000;
    const laggy = {
      now: () => sched.now(),
      setTimeout: (fn: () => void, ms: number) => {
        const h = sched.setTimeout(fn, ms + lag);
        lag = 0;
        return h;
      },
      clearTimeout: (h: unknown) => sched.clearTimeout(h),
    };
    const r2 = new RealtimeRunner(sim, laggy, { tickMs: 5, maxCatchUpMs: 100 });
    const before = sim.timeMs;
    r2.start();
    sched.advance(5005);
    expect(sim.timeMs - before).toBeLessThanOrEqual(101);
    expect(r2.droppedMs).toBeGreaterThan(4800);
    r2.stop();
    expect(r2.running).toBe(false);
  });
});
