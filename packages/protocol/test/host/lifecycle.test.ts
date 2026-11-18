import { describe, expect, it } from 'vitest';
import { Cls, Command, CommandStatus, Model } from '../../src/core/constants';
import { CygnusBus } from '../../src/host/bus';
import type { DeviceHandle } from '../../src/host/types';
import { ManualScheduler } from '../../src/transport/scheduler';
import { FakeBus, flush, run } from '../helpers/fake-bus';
import { caught, rig } from '../helpers/setup';

describe('stop and disconnect', () => {
  it('stop() rejects pending work with DISCONNECTED and leaves no timers or subscriptions', async () => {
    const r = await rig();
    const esc = r.node({ model: Model.ESC_20A, seed: 90, num: 1 });
    const enc = r.node({ model: Model.CYNCODER, seed: 91, num: 1 });
    const h = await r.ready(esc);
    await r.ready(enc);
    const sub = h.stream.open({ signals: ['velocity'], periodUs: 1000 });
    h.control.start('duty', 0.2);
    esc.mute.add(Cls.PARAM_REQ);
    enc.mute.add(Cls.SYS_REQ);
    esc.commandScripts.set(Command.SELF_TEST, { status: CommandStatus.OK, delayMs: 10_000 });
    const pGet = h.getParam('vel.kp');
    const pCmd = h.selfTest();
    const pAssign = r.bus.assignId(r.bus.deviceByUid(enc.uid48)!.uid48, 5);
    await run(r.sched, 20);
    const removed: DeviceHandle[] = [];
    r.bus.on('deviceRemoved', (d) => removed.push(d));
    await r.bus.stop();
    for (const p of [pGet, pCmd, pAssign]) expect(await caught(p)).toMatchObject({ code: 'DISCONNECTED' });
    expect(removed).toHaveLength(2);
    expect(r.bus.devices).toEqual([]);
    expect(sub.closed).toBe(true);
    expect(h.control.active).toBe(false);
    expect(r.transport.listenerCount).toBe(0);
    esc.destroy();
    enc.destroy();
    r.sched.advance(10);
    await flush();
    expect(r.sched.pending).toBe(0);
    // Operations after stop fail fast instead of hanging.
    expect(await caught(h.getParam('vel.kp'))).toMatchObject({ code: 'DISCONNECTED' });
  });

  it('a bus that never saw a board stops cleanly too', async () => {
    const sched = new ManualScheduler();
    const wire = new FakeBus(sched);
    const bus = new CygnusBus(wire.transport(), sched);
    const states: string[] = [];
    bus.on('transportState', (s) => states.push(s.phase));
    await bus.start();
    await run(sched, 2500);
    await bus.stop();
    sched.advance(1);
    expect(sched.pending).toBe(0);
    expect(states).toEqual(['opening', 'open', 'closed']);
  });

  it('transport failure fails requests, marks boards lost and rediscovers the same handles', async () => {
    const r = await rig();
    const n = r.node({ model: Model.ESC_20A, seed: 92, num: 1 });
    const h = await r.ready(n);
    n.mute.add(Cls.PARAM_REQ);
    const p = h.getParam('vel.kp');
    const sub = h.stream.open({ signals: ['duty'], periodUs: 1000 });
    h.control.start('duty', 0.1);
    const lost: DeviceHandle[] = [];
    r.bus.on('deviceLost', (d) => lost.push(d));
    r.transport.fail('unplugged');
    expect(await caught(p)).toMatchObject({ code: 'DISCONNECTED' });
    expect(lost).toEqual([h]);
    expect(h.online).toBe(false);
    expect(h.control.active).toBe(false);
    expect(sub.closed).toBe(true);
    expect(r.bus.state).toMatchObject({ phase: 'error', error: 'unplugged' });
    n.mute.clear();
    await r.transport.open();
    await run(r.sched, 1200);
    expect(h.online).toBe(true);
    expect(r.bus.deviceByUid(h.uid48)).toBe(h);
    await r.bus.stop();
  });
});
