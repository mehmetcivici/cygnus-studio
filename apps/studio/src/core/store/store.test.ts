import { describe, expect, it } from 'vitest';
import { CygnusBus, ManualScheduler, type DeviceHandle, type SignalUpdate } from '@cygnus/protocol';
import { RealtimeRunner, createScenario } from '@cygnus/simulator';
import { ManualUiClock } from '../util/clock';
import { SignalHub } from './signalHub';
import { bindBusStore, useBusStore } from './busStore';

/** Just enough of a DeviceHandle for the hub. */
function fakeDevice(uid48: string) {
  const listeners = new Set<(u: SignalUpdate) => void>();
  const values: Record<string, number> = {};
  const handle = {
    uid48,
    getSignal: (k: string) => values[k] ?? NaN,
    onSignals: (cb: (u: SignalUpdate) => void) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
  return {
    handle: handle as unknown as DeviceHandle,
    listeners,
    emit(t: number, patch: Record<string, number>) {
      Object.assign(values, patch);
      const u: SignalUpdate = { t, frame: 0, keys: Object.keys(patch), values };
      for (const l of listeners) l(u);
    },
  };
}

describe('SignalHub', () => {
  it('coalesces a burst of frames into one notification with the latest value', () => {
    const clock = new ManualUiClock();
    const hub = new SignalHub(clock, 50);
    const dev = fakeDevice('a');
    hub.setResolver((uid) => (uid === 'a' ? dev.handle : undefined));
    let calls = 0;
    hub.subscribe('a', 'velocity', () => calls++);
    for (let i = 1; i <= 200; i++) dev.emit(i, { velocity: i });
    expect(hub.read('a', 'velocity')).toBeNaN();
    clock.advance(0);
    expect(calls).toBe(1);
    expect(hub.read('a', 'velocity')).toBe(200);
    // Within the 50 ms budget nothing is published even though frames keep coming.
    dev.emit(201, { velocity: 201 });
    clock.advance(20);
    expect(calls).toBe(1);
    clock.advance(30);
    expect(calls).toBe(2);
    expect(hub.read('a', 'velocity')).toBe(201);
  });

  it('notifies only listeners of keys that changed, and not for repeated values', () => {
    const clock = new ManualUiClock();
    const hub = new SignalHub(clock, 50);
    const dev = fakeDevice('a');
    hub.setResolver(() => dev.handle);
    let vel = 0;
    let cur = 0;
    hub.subscribe('a', 'velocity', () => vel++);
    hub.subscribe('a', 'current', () => cur++);
    dev.emit(1, { velocity: 5 });
    clock.advance(100);
    dev.emit(2, { velocity: 5, current: 0 });
    clock.advance(100);
    expect(vel).toBe(1);
    expect(cur).toBe(1);
  });

  it('keeps one board subscription per device and drops it with the last listener', () => {
    const clock = new ManualUiClock();
    const hub = new SignalHub(clock, 50);
    const dev = fakeDevice('a');
    hub.setResolver(() => dev.handle);
    const off1 = hub.subscribe('a', 'x', () => undefined);
    const off2 = hub.subscribe('a', 'y', () => undefined);
    expect(dev.listeners.size).toBe(1);
    off1();
    expect(hub.tapCount).toBe(1);
    off2();
    expect(hub.tapCount).toBe(0);
    expect(dev.listeners.size).toBe(0);
  });

  it('subscribes before the board exists and attaches when it appears', () => {
    const clock = new ManualUiClock();
    const hub = new SignalHub(clock, 50);
    const dev = fakeDevice('a');
    let present = false;
    hub.setResolver(() => (present ? dev.handle : undefined));
    let calls = 0;
    hub.subscribe('a', 'x', () => calls++);
    expect(dev.listeners.size).toBe(0);
    present = true;
    hub.deviceAvailable('a');
    dev.emit(1, { x: 3 });
    clock.advance(60);
    expect(hub.read('a', 'x')).toBe(3);
    expect(calls).toBe(1);
    // Bus gone: values reset to NaN for the watchers.
    hub.setResolver(null);
    clock.advance(60);
    expect(hub.read('a', 'x')).toBeNaN();
  });
});

describe('bus store', () => {
  function setup(scenario: string) {
    const sched = new ManualScheduler(1000);
    const sim = createScenario(scenario, { seed: 1 });
    const runner = new RealtimeRunner(sim, sched, { tickMs: 2 });
    const bus = new CygnusBus(sim.createTransport(), sched);
    const clock = new ManualUiClock();
    const unbind = bindBusStore(bus, clock);
    runner.start();
    const step = (ms: number): void => {
      for (let t = 0; t < ms; t += 10) {
        sched.advance(10);
        clock.advance(10);
      }
    };
    return { bus, sim, step, unbind, clock };
  }

  it('mirrors discovered boards and batches device events', async () => {
    const { bus, step, unbind } = setup('all.devices');
    const start = bus.start();
    step(50);
    await start;
    step(2500);
    const st = useBusStore.getState();
    expect(st.devices.length).toBe(bus.devices.length);
    expect(st.devices.length).toBeGreaterThan(8);
    expect(st.devices.every((d) => st.byUid[d.uid48] === d)).toBe(true);
    expect(st.devices.every((d) => d.online)).toBe(true);
    // Quiet bus: a flush without device events keeps every view reference-equal.
    const before = st.devices;
    step(200);
    const after = useBusStore.getState().devices;
    expect(after.filter((d, i) => d === before[i]).length).toBe(after.length);
    unbind();
    expect(useBusStore.getState().devices).toHaveLength(0);
    await bus.stop();
  });

  it('lists unresolved boards of a factory-fresh bus', async () => {
    const { bus, step, unbind } = setup('factory.fresh');
    const start = bus.start();
    step(50);
    await start;
    step(2500);
    const st = useBusStore.getState();
    expect(st.unresolved.length).toBeGreaterThan(0);
    expect(st.unresolved.every((u) => st.byUid[u]?.unassigned || st.byUid[u]?.conflict)).toBe(true);
    unbind();
    await bus.stop();
  });
});
