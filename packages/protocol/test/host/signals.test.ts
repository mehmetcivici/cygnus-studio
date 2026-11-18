import { describe, expect, it } from 'vitest';
import { Model } from '../../src/core/constants';
import type { CanFrame } from '../../src/core/frame';
import { encodeId } from '../../src/core/id';
import { CygnusBus } from '../../src/host/bus';
import type { BusDriver, DeviceHandle, DriverContext } from '../../src/host/types';
import { ManualScheduler } from '../../src/transport/scheduler';
import { FakeBus, run, settle } from '../helpers/fake-bus';
import { rig } from '../helpers/setup';

describe('STATUS signals', () => {
  it('decodes status frames into the signal view with one callback per frame', async () => {
    const r = await rig();
    const n = r.node({ model: Model.ESC_20A, seed: 100, num: 1, status: true });
    Object.assign(n.signalValues, { velocity: 1500, 'phase.current': 4.25, duty: 0.3, position: 2.5, 'bus.voltage': 12.6 });
    const h = await r.ready(n);
    expect(Number.isNaN(h.getSignal('no.such'))).toBe(true);
    const frames: number[] = [];
    let keysOfFrame0: readonly string[] = [];
    const off = h.onSignals((u) => {
      frames.push(u.frame);
      if (u.frame === 0) keysOfFrame0 = u.keys;
      expect(u.values).toBe(h.signals);
    });
    await run(r.sched, 100);
    off();
    expect(h.getSignal('velocity')).toBe(1500);
    expect(h.getSignal('phase.current')).toBeCloseTo(4.25);
    expect(h.signals['bus.voltage']).toBeCloseTo(12.6);
    // Default periods (PROTOCOL §10.1 budget): frame 0 every 20 ms, frame 1 every 50 ms.
    expect(frames.filter((f) => f === 0).length).toBeGreaterThanOrEqual(4);
    expect(frames.filter((f) => f === 1).length).toBeGreaterThanOrEqual(1);
    expect(keysOfFrame0).toEqual(['velocity', 'phase.current', 'duty']);
    const count = frames.length;
    await run(r.sched, 50);
    expect(frames.length).toBe(count);
  });

  it('reboot invalidates cached parameters and the board comes back', async () => {
    const r = await rig();
    const n = r.node({ model: Model.ESC_20A, seed: 101, num: 1 });
    const h = await r.ready(n);
    await settle(r.sched, h.getParam('vel.kp'));
    await settle(r.sched, h.reboot());
    await run(r.sched, 2500);
    expect(h.online).toBe(true);
    expect(h.infoLoaded).toBe(true);
  });
});

describe('driver abstraction', () => {
  it('hands frames CyCAN does not claim to extra drivers and lists their devices', async () => {
    const sched = new ManualScheduler();
    const wire = new FakeBus(sched);
    const seen: CanFrame[] = [];
    let ctx: DriverContext | undefined;
    const fakeDevice = { driver: 'legacy', devType: 10, num: 1, uid48: '000000000001' } as unknown as DeviceHandle;
    const legacy: BusDriver = {
      id: 'legacy',
      attach: (c) => (ctx = c),
      start: () => undefined,
      handleFrame: (f) => {
        if (((f.id >>> 10) & 0x3f) > 0x0f) return false;
        seen.push(f);
        return true;
      },
      transportDown: () => undefined,
      stop: () => undefined,
      devices: () => [fakeDevice],
      haltControl: () => undefined,
    };
    const bus = new CygnusBus(wire.transport(), sched, { drivers: [legacy] });
    await bus.start();
    const node = { receive: () => undefined };
    wire.attach(node);
    wire.fromNode(node, { id: encodeId({ devType: 10, cls: 0, index: 0, num: 1 }), data: new Uint8Array(8), fd: false, brs: false });
    await run(sched, 5);
    expect(seen).toHaveLength(1);
    expect(ctx?.isOpen()).toBe(true);
    expect(bus.devices).toContain(fakeDevice);
    await bus.stop();
  });
});
