import { describe, expect, it } from 'vitest';
import { Cls, DeviceState, Model, SysReq } from '../../src/core/constants';
import { idClass, idIndex } from '../../src/core/id';
import { decodeCtrlServo, decodeCtrlSet } from '../../src/core/messages';
import { EscMode } from '../../src/catalog';
import { run, settle } from '../helpers/fake-bus';
import { rig } from '../helpers/setup';

describe('control', () => {
  it('repeats the command at 50 Hz, follows updates and sends neutral on stop', async () => {
    const r = await rig();
    const n = r.node({ model: Model.ESC_20A, seed: 50, num: 1 });
    const h = await r.ready(n);
    const loop = h.control.start('velocity', 1000);
    expect(h.control.active).toBe(true);
    expect(h.control.periodMs).toBe(20);
    await run(r.sched, 100);
    expect(n.ctrl.length).toBeGreaterThanOrEqual(6);
    // Neutral-first rule: the session opens with a neutral command, then the target.
    expect(decodeCtrlSet(n.ctrl[0]!.frame.data)).toMatchObject({ mode: EscMode.OFF, value: 0 });
    expect(decodeCtrlSet(n.ctrl[1]!.frame.data)).toMatchObject({ mode: EscMode.VELOCITY, value: 1000 });
    expect(n.ctrl[1]!.t).toBe(n.ctrl[0]!.t);
    const targets = n.ctrl.slice(1);
    const gaps = targets.slice(1).map((c, i) => c.t - (targets[i]?.t ?? 0));
    expect(new Set(gaps)).toEqual(new Set([20]));
    expect(n.enabled).toBe(true);
    loop.update(2000);
    await run(r.sched, 25);
    expect(decodeCtrlSet(n.ctrl.at(-1)!.frame.data)).toMatchObject({ mode: EscMode.VELOCITY, value: 2000 });
    loop.stop();
    await run(r.sched, 5);
    expect(decodeCtrlSet(n.ctrl.at(-1)!.frame.data)).toMatchObject({ mode: EscMode.OFF, value: 0 });
    expect(n.enabled).toBe(false);
    const count = n.ctrl.length;
    await run(r.sched, 200);
    expect(n.ctrl.length).toBe(count);
    expect(loop.active).toBe(false);
    loop.update(5);
    await run(r.sched, 50);
    expect(n.ctrl.length).toBe(count);
  });

  it('validates modes and ranges and adapts the period to ctrl.timeout_ms', async () => {
    const r = await rig();
    const n = r.node({ model: Model.ESC_20A, seed: 51, num: 1 });
    const h = await r.ready(n);
    expect(() => h.control.set('velocity', 1e9)).toThrow(expect.objectContaining({ code: 'INVALID', reason: 'out_of_range' }));
    expect(() => h.control.set('warp', 1)).toThrow(expect.objectContaining({ reason: 'unknown_mode' }));
    await settle(r.sched, h.setParam('ctrl.timeout_ms', 40));
    h.control.start(EscMode.DUTY, 0.5);
    expect(h.control.periodMs).toBe(10);
    h.control.stop();
    h.control.set('duty', -0.25);
    await run(r.sched, 5);
    expect(decodeCtrlSet(n.ctrl.at(-1)!.frame.data)).toMatchObject({ mode: EscMode.DUTY, value: -0.25 });
  });

  it('drives multi-frame controls generically (servo16) and neutralises every frame', async () => {
    const r = await rig();
    const n = r.node({ model: Model.SERVO_16CH, seed: 52, num: 1 });
    const h = await r.ready(n);
    h.control.send('channels_1_4', { pulsesUs: [1500, 1600] }, { repeat: true });
    h.control.send('channels_9_12', { pulsesUs: [1000, 0, 0, 2000] }, { repeat: true });
    await run(r.sched, 45);
    const idx = new Set(n.ctrl.map((c) => idIndex(c.frame.id)));
    expect(idx).toEqual(new Set([0, 2]));
    h.control.stop();
    await run(r.sched, 5);
    const last = n.ctrl.slice(-2).map((c) => decodeCtrlServo(c.frame.data, idIndex(c.frame.id)));
    expect(last.map((m) => m?.pulsesUs)).toEqual([
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ]);
    expect(() => h.control.start('position', 1)).toThrow(expect.objectContaining({ code: 'NOT_SUPPORTED' }));
  });

  it('stops the loop when the board is lost', async () => {
    const r = await rig();
    const n = r.node({ model: Model.SEALED_SERVO, seed: 53, num: 1 });
    const h = await r.ready(n);
    h.control.start('position', 90);
    n.powerOff();
    await run(r.sched, 2100);
    expect(h.online).toBe(false);
    expect(h.control.active).toBe(false);
  });
});

describe('estop', () => {
  it('halts every control loop and broadcasts ESTOP', async () => {
    const r = await rig();
    const a = r.node({ model: Model.ESC_20A, seed: 54, num: 1 });
    const b = r.node({ model: Model.ESC_80A, seed: 55, num: 2 });
    const ha = await r.ready(a);
    const hb = await r.ready(b);
    ha.control.start('duty', 0.3);
    hb.control.start('duty', -0.3);
    await run(r.sched, 50);
    r.bus.estop();
    const sentAfter = r.transport.sent.length;
    const estop = r.transport.sent.at(-1)!;
    expect(idClass(estop.id)).toBe(Cls.SYS_REQ);
    expect(idIndex(estop.id)).toBe(SysReq.ESTOP);
    expect([...estop.data]).toEqual([0xe5, 0x70]);
    await run(r.sched, 600);
    expect(ha.control.active || hb.control.active).toBe(false);
    expect(r.transport.sent.slice(sentAfter).some((f) => idClass(f.id) === Cls.CTRL)).toBe(false);
    expect(a.state).toBe(DeviceState.ESTOP);
    expect(ha.state).toBe(DeviceState.ESTOP);
    await settle(r.sched, ha.clearEstop());
    await run(r.sched, 600);
    expect(ha.state).toBe(DeviceState.IDLE);
  });
});
