import type { DeviceHandle } from '@cygnus/protocol';
import { describe, expect, it } from 'vitest';
import { applyPlan, type ApplyBus, type PlanStep } from '../src';

interface FakeDev {
  uid48: string;
  devType: number;
  num: number;
  name: string;
  params: Map<string, number>;
  saved: number;
}

/** Records calls and fails on a number that is still held (what would put two boards in CONFLICT). */
function fakeBus(devs: FakeDev[], failOn?: string): { bus: ApplyBus; log: string[] } {
  const log: string[] = [];
  const handle = (d: FakeDev): DeviceHandle =>
    ({
      ...d,
      online: true,
      rename: async (n: string) => {
        log.push(`rename ${d.uid48} ${n}`);
        d.name = n;
      },
      setParam: async (k: string, v: number) => {
        if (k === failOn) throw new Error('rejected');
        log.push(`set ${d.uid48} ${k}=${v}`);
        d.params.set(k, v);
        return v;
      },
      save: async () => {
        log.push(`save ${d.uid48}`);
        d.saved++;
      },
    }) as unknown as DeviceHandle;
  const bus: ApplyBus = {
    get devices() {
      return devs.map(handle);
    },
    deviceByUid: (u) => {
      const d = devs.find((x) => x.uid48 === u);
      return d ? handle(d) : undefined;
    },
    assignId: async (u, num) => {
      const d = devs.find((x) => x.uid48 === u)!;
      if (devs.some((x) => x !== d && x.devType === d.devType && x.num === num)) throw new Error(`#${num} still held`);
      log.push(`assign ${u} ${num}`);
      d.num = num;
    },
  };
  return { bus, log };
}

const dev = (uid48: string, num: number): FakeDev => ({ uid48, devType: 2, num, name: '', params: new Map(), saved: 0 });

describe('applyPlan', () => {
  it('runs numbers first, then names and parameters, then saves each touched board once', async () => {
    const a = dev('aa', 63);
    const b = dev('bb', 63);
    const { bus, log } = fakeBus([a, b]);
    const steps: PlanStep[] = [
      { kind: 'assignNum', uid48: 'aa', slotId: 's1', devType: 2, from: 63, to: 1 },
      { kind: 'assignNum', uid48: 'bb', slotId: 's2', devType: 2, from: 63, to: 2 },
      { kind: 'rename', uid48: 'aa', slotId: 's1', from: '', to: 'Sol' },
      { kind: 'setParam', uid48: 'aa', slotId: 's1', key: 'motor.invert', value: 1 },
      { kind: 'setParam', uid48: 'bb', slotId: 's2', key: 'motor.invert', value: 0 },
    ];
    const seen: string[] = [];
    const res = await applyPlan(bus, { steps, warnings: [] }, { onStep: (r) => seen.push(r.step.kind) });
    expect(res.ok).toBe(true);
    expect(log).toEqual(['assign aa 1', 'assign bb 2', 'rename aa Sol', 'set aa motor.invert=1', 'set bb motor.invert=0', 'save aa', 'save bb']);
    expect(seen).toEqual(['assignNum', 'assignNum', 'rename', 'setParam', 'setParam', 'save', 'save']);
  });

  it('orders a chain and breaks a swap through a temporary number', async () => {
    const a = dev('aa', 1);
    const b = dev('bb', 2);
    const c = dev('cc', 3);
    const { bus, log } = fakeBus([a, b, c]);
    const res = await applyPlan(bus, [
      { kind: 'assignNum', uid48: 'aa', slotId: 'x', devType: 2, from: 1, to: 2 },
      { kind: 'assignNum', uid48: 'bb', slotId: 'y', devType: 2, from: 2, to: 1 },
      { kind: 'assignNum', uid48: 'cc', slotId: 'z', devType: 2, from: 3, to: 4 },
    ]);
    expect(res.ok).toBe(true);
    expect([a.num, b.num, c.num]).toEqual([2, 1, 4]);
    expect(log).toContain('assign aa 62');
    expect(res.results.some((r) => r.step.kind === 'assignTemp')).toBe(true);
  });

  it('stops at the first failure and reports the rest as skipped', async () => {
    const a = dev('aa', 1);
    const { bus } = fakeBus([a], 'bad.key');
    const res = await applyPlan(bus, [
      { kind: 'setParam', uid48: 'aa', slotId: 's', key: 'bad.key', value: 1 },
      { kind: 'rename', uid48: 'aa', slotId: 's', from: '', to: 'X' },
    ]);
    expect(res.ok).toBe(false);
    expect(res.results).toHaveLength(1);
    expect(res.results[0]!.error?.message).toBe('rejected');
    expect(res.skipped.map((s) => s.kind)).toEqual(['rename', 'save']);
    expect(a.saved).toBe(0);
  });

  it('persist: false assigns without flash writes and does not save', async () => {
    const a = dev('aa', 63);
    const { bus, log } = fakeBus([a]);
    await applyPlan(bus, [{ kind: 'rename', uid48: 'aa', slotId: 's', from: '', to: 'X' }], { persist: false });
    expect(log).toEqual(['rename aa X']);
  });
});
