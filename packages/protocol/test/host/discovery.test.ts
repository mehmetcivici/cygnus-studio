import { describe, expect, it } from 'vitest';
import { DeviceState, Model } from '../../src/core/constants';
import type { DeviceHandle } from '../../src/host/types';
import { run } from '../helpers/fake-bus';
import { rig } from '../helpers/setup';

describe('discovery', () => {
  it('finds boards, reads INFO lazily and maps the catalog', async () => {
    const r = await rig();
    const esc = r.node({ model: Model.ESC_20A, seed: 1, num: 3, fw: [1, 2, 3], hwRev: 2, name: 'Sol ön itici' });
    const enc = r.node({ model: Model.CYNCODER, seed: 2, num: 3 });
    const added: DeviceHandle[] = [];
    r.bus.on('deviceAdded', (d) => added.push(d));
    const h = await r.ready(esc);
    await r.ready(enc);
    expect(added).toHaveLength(2);
    expect(h.uid48).toBe(esc.uid48.toString(16).padStart(12, '0'));
    expect(h.uid96).toHaveLength(24);
    expect(h.def?.key).toBe('esc20a');
    expect(h.catalogStatus).toBe('ok');
    expect(h.devType).toBe(2);
    expect(h.num).toBe(3);
    expect(h.name).toBe('Sol ön itici');
    expect(h.hwRev).toBe(2);
    expect(h.fw).toEqual({ major: 1, minor: 2, patch: 3 });
    expect(h.build?.gitHash).toBe(0xdeadbeef);
    expect(h.state).toBe(DeviceState.IDLE);
    // Same number, different types: two separate addresses.
    expect(r.bus.device(2, 3)).toBe(h);
    expect(r.bus.device(7, 3)?.model).toBe(Model.CYNCODER);
  });

  it('flags unknown models and newer catalog revisions', async () => {
    const r = await rig();
    const n = r.node({ model: Model.GYRO, seed: 3, num: 1, catalogRev: 99 });
    const h = await r.ready(n);
    expect(h.catalogStatus).toBe('newerCatalog');
    // Unknown model: patch the ENUM answer through a fake model code.
    const u = r.node({ model: Model.GYRO, seed: 4, num: 2 });
    (u as unknown as { def: { model: number } }).def = { ...u.def, model: 200 };
    const hu = await r.ready(u);
    expect(hu.catalogStatus).toBe('unknownModel');
    expect(hu.capabilities.params).toBe(false);
    await expect(hu.getParam('can.termination')).rejects.toMatchObject({ code: 'NOT_SUPPORTED' });
  });

  it('marks a silent board lost after 1500 ms and keeps the handle when it returns', async () => {
    const r = await rig();
    const n = r.node({ model: Model.ESC_80A, seed: 5, num: 4 });
    const h = await r.ready(n);
    const lost: DeviceHandle[] = [];
    r.bus.on('deviceLost', (d) => lost.push(d));
    n.powerOff();
    await run(r.sched, 1400);
    expect(h.online).toBe(true);
    await run(r.sched, 700);
    expect(h.online).toBe(false);
    expect(lost).toEqual([h]);
    n.powerOn();
    await run(r.sched, 1200);
    expect(h.online).toBe(true);
    expect(r.bus.deviceByUid(h.uid48)).toBe(h);
    expect(r.bus.devices).toHaveLength(1);
  });

  it('keeps the handle when the number changes and re-indexes the address', async () => {
    const r = await rig();
    const n = r.node({ model: Model.ESC_20A, seed: 6, num: 1 });
    const h = await r.ready(n);
    const p = r.bus.assignId(h.uid48, 9, { persist: true });
    await run(r.sched, 300);
    await p;
    expect(h.num).toBe(9);
    expect(n.num).toBe(9);
    expect(n.persistedNum).toBe(9);
    expect(r.bus.device(2, 9)).toBe(h);
    expect(r.bus.device(2, 1)).toBeUndefined();
  });

  it('enumerates late boards found through an unknown heartbeat', async () => {
    const r = await rig();
    await run(r.sched, 1100);
    const n = r.node({ model: Model.SERVO_16CH, seed: 7, num: 2 });
    await run(r.sched, 300);
    // The heartbeat from an unknown address triggers an early ENUM round.
    expect(r.bus.deviceByUid(n.uid48)).toBeDefined();
  });

  it('counts discovery misses and emits stats', async () => {
    const r = await rig();
    r.node({ model: Model.ESC_20A, seed: 8, num: 1 });
    const stats: number[] = [];
    r.bus.on('stats', (s) => stats.push(s.rxFps));
    await run(r.sched, 3000);
    expect(stats.length).toBeGreaterThanOrEqual(2);
    expect(r.bus.currentStats.rxFps).toBeGreaterThan(0);
    expect(r.bus.currentStats.txFps).toBeGreaterThan(0);
    expect(r.bus.currentStats.loadPct).toBeGreaterThan(0);
    expect(r.bus.currentStats.loadPct).toBeLessThan(5);
    expect(r.bus.currentStats.enumTimeouts).toBe(0);
    r.wire.drop = (f, from) => from === 'node' && ((f.id >>> 10) & 0x3f) === 0x1b;
    await run(r.sched, 1100);
    expect(r.bus.currentStats.enumTimeouts + r.bus.devices.length).toBeGreaterThan(1);
  });

  it('emits raw frames only to subscribers', async () => {
    const r = await rig();
    r.node({ model: Model.ESC_20A, seed: 9, num: 1 });
    const dirs = new Set<string>();
    const off = r.bus.on('frame', (e) => dirs.add(e.dir));
    await run(r.sched, 600);
    expect(dirs).toEqual(new Set(['rx', 'tx']));
    off();
  });
});
