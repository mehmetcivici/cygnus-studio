import { describe, expect, it } from 'vitest';
import { CygnusBus, ManualScheduler } from '@cygnus/protocol';
import { RealtimeRunner, createScenario } from '@cygnus/simulator';
import { ParamCache } from './paramCache';

async function rig() {
  const sched = new ManualScheduler(1000);
  const sim = createScenario('bench.flywheel', { seed: 1 });
  const runner = new RealtimeRunner(sim, sched, { tickMs: 2 });
  const bus = new CygnusBus(sim.createTransport(), sched);
  runner.start();
  const step = async (ms: number): Promise<void> => {
    for (let t = 0; t < ms; t += 10) {
      sched.advance(10);
      await Promise.resolve();
      await Promise.resolve();
    }
  };
  const start = bus.start();
  await step(50);
  await start;
  await step(2500);
  return { bus, step };
}

describe('ParamCache across a reboot (uygulama #7)', () => {
  it('does not fail watched keys while the board boots, and reads them again when it is back', async () => {
    const { bus, step } = await rig();
    const d = bus.devices.find((x) => x.capabilities.params && x.capabilities.control);
    if (!d?.def) throw new Error('no board');
    const pc = new ParamCache();
    pc.setResolver((u) => bus.deviceByUid(u));
    const keys = d.def.params.map((p) => p.key).slice(0, 25);
    for (const k of keys) pc.subscribe(d.uid48, k, () => undefined);
    await step(3000);
    const count = () => {
      const s = keys.map((k) => pc.read(d.uid48, k));
      return { values: s.filter((x) => x.value !== undefined).length, errors: s.filter((x) => x.error).length };
    };
    expect(count().values).toBe(keys.length);
    const reboot = d.reboot().catch(() => undefined);
    await step(200);
    await reboot;
    await step(12_000);
    expect(count()).toEqual({ values: keys.length, errors: 0 });
    await bus.stop();
  }, 30_000);
});

describe('ParamCache with a board that rejects reads while booting', () => {
  it('waits for BOOT to end instead of latching errors, then reads again', async () => {
    type Ev = 'paramChanged' | 'paramsInvalidated' | 'changed';
    const ls = new Map<Ev, Set<(p: unknown) => void>>();
    let reads = 0;
    const h = {
      uid48: 'aa',
      online: true,
      bootloader: false,
      unassigned: false,
      conflict: false,
      state: 2,
      capabilities: { params: true },
      cachedParam: () => undefined,
      getParam: (): Promise<number> => {
        reads++;
        return h.state === 0 ? Promise.reject(new Error('no answer')) : Promise.resolve(42);
      },
      on: (ev: Ev, cb: (p: unknown) => void) => {
        if (!ls.has(ev)) ls.set(ev, new Set());
        ls.get(ev)?.add(cb);
        return () => ls.get(ev)?.delete(cb);
      },
    };
    const emit = (ev: Ev) => ls.get(ev)?.forEach((cb) => cb(h));
    const flush = () => new Promise((r) => setTimeout(r, 0));
    const pc = new ParamCache();
    pc.setResolver(() => h as never);
    pc.subscribe('aa', 'k', () => undefined);
    await flush();
    expect(pc.read('aa', 'k').value).toBe(42);
    // reboot: BOOT state, cache invalidated
    h.state = 0;
    emit('changed');
    emit('paramsInvalidated');
    await flush();
    expect(pc.read('aa', 'k')).toMatchObject({ value: undefined, error: null });
    const during = reads;
    h.state = 2;
    emit('changed');
    await flush();
    expect(reads).toBe(during + 1);
    expect(pc.read('aa', 'k')).toMatchObject({ value: 42, error: null });
  });
});
