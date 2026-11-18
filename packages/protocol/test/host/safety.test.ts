import { describe, expect, it } from 'vitest';
import { EscMode } from '../../src/catalog';
import { Cls, CommandStatus, DeviceState, ESTOP_REPEAT_COUNT, Model, SysReq } from '../../src/core/constants';
import { BROADCAST_ALL } from '../../src/core/frame';
import { idClass, idIndex, idNum } from '../../src/core/id';
import { decodeCtrlSet, encodeAssignId, encodeEstop } from '../../src/core/messages';
import type { ControlStopReason } from '../../src/host/types';
import { run, settle } from '../helpers/fake-bus';
import { caught, rig } from '../helpers/setup';

/** A second host on the same bus (a roboRIO, another Studio). */
async function otherHost(r: Awaited<ReturnType<typeof rig>>) {
  const t = r.wire.transport();
  await t.open();
  return t;
}

describe('control safety', () => {
  it('refuses to renumber a driven board, and stops driving when another host renumbers it', async () => {
    const r = await rig();
    const a = r.node({ model: Model.ESC_20A, seed: 300, num: 1 });
    const b = r.node({ model: Model.ESC_20A, seed: 301, num: 2 });
    const ha = await r.ready(a);
    await r.ready(b);
    const reasons: ControlStopReason[] = [];
    const loop = ha.control.start('duty', 0.3, { onStopped: (x) => reasons.push(x) });
    await run(r.sched, 600);
    expect(a.enabled).toBe(true);
    expect(await caught(r.bus.assignId(ha.uid48, 3))).toMatchObject({ code: 'BUSY', reason: 'driving' });
    // Handing the driven board's number to someone else is refused too.
    expect(await caught(r.bus.assignId(b.uid48, 1, { force: true }))).toMatchObject({ code: 'BUSY' });

    // Another host swaps the numbers behind our back (the review's reproduction).
    const other = await otherHost(r);
    other.send(encodeAssignId(BROADCAST_ALL, { uid48: a.uid48, newNum: 3, persist: false }));
    await run(r.sched, 150);
    other.send(encodeAssignId(BROADCAST_ALL, { uid48: b.uid48, newNum: 1, persist: false }));
    await run(r.sched, 1000);
    expect(loop.active).toBe(false);
    expect(loop.stopReason).toBe('renumbered');
    expect(reasons).toEqual(['renumbered']);
    expect(ha.num).toBe(3);
    expect(a.enabled).toBe(false);
    expect(b.enabled).toBe(false);
    // Nothing but neutral commands ever reached B, and the last CTRL went to the old address #1.
    expect(b.ctrl.every((c) => decodeCtrlSet(c.frame.data)?.mode === EscMode.OFF)).toBe(true);
    const ctrl = r.transport.sent.filter((f) => idClass(f.id) === Cls.CTRL);
    expect(idNum(ctrl.at(-1)!.id)).toBe(1);
    expect(decodeCtrlSet(ctrl.at(-1)!.data)).toMatchObject({ mode: EscMode.OFF, value: 0 });
  });

  it('allows renumbering right after the own loop was stopped', async () => {
    const r = await rig();
    const a = r.node({ model: Model.ESC_20A, seed: 302, num: 1 });
    const ha = await r.ready(a);
    const loop = ha.control.start('duty', 0.2);
    await run(r.sched, 600);
    expect(ha.flags.enabled).toBe(true);
    loop.stop();
    await settle(r.sched, r.bus.assignId(ha.uid48, 4));
    expect(a.num).toBe(4);
  });

  it('stops the loop when another node sends ESTOP; clearing it does not restart the motor', async () => {
    const r = await rig();
    const a = r.node({ model: Model.ESC_80A, seed: 303, num: 1 });
    const ha = await r.ready(a);
    const events: ControlStopReason[] = [];
    ha.on('controlStopped', (e) => events.push(e.reason));
    const loop = ha.control.start('duty', 0.4);
    await run(r.sched, 100);
    const other = await otherHost(r);
    other.send(encodeEstop(BROADCAST_ALL));
    await run(r.sched, 600);
    expect(ha.state).toBe(DeviceState.ESTOP);
    expect(loop.active).toBe(false);
    expect(loop.stopReason).toBe('boardEstop');
    expect(events).toEqual(['boardEstop']);
    await settle(r.sched, ha.clearEstop());
    await run(r.sched, 600);
    expect(a.state).toBe(DeviceState.IDLE);
    expect(a.enabled).toBe(false);
  });

  it('stops the loop, drops the cache and rebuilds the stream after a short power cut', async () => {
    const r = await rig();
    const a = r.node({ model: Model.ESC_20A, seed: 304, num: 1 });
    const ha = await r.ready(a);
    await settle(r.sched, ha.setParam('vel.kp', 0.003));
    expect(a.param('vel.kp')).toBeCloseTo(0.003);
    let invalidated = 0;
    ha.on('paramsInvalidated', () => invalidated++);
    const sub = ha.stream.open({ signals: ['velocity'], periodUs: 2000 });
    const loop = ha.control.start('duty', 0.3);
    await run(r.sched, 100);
    a.powerOff();
    await run(r.sched, 300);
    a.powerOn();
    await run(r.sched, 1000);
    expect(ha.online).toBe(true);
    expect(loop.stopReason).toBe('boardReset');
    expect(a.enabled).toBe(false);
    expect(invalidated).toBe(1);
    expect(ha.cachedParam('vel.kp')).toBeUndefined();
    expect(a.param('vel.kp')).not.toBeCloseTo(0.003, 6);
    const before = sub.samples;
    await run(r.sched, 200);
    expect(sub.samples - before).toBeGreaterThanOrEqual(90);
  });

  it('stops the loop when the board drops ENABLED (CTRL timeout)', async () => {
    const r = await rig();
    const a = r.node({ model: Model.ESC_20A, seed: 305, num: 1 });
    const ha = await r.ready(a);
    const loop = ha.control.start('velocity', 500);
    await run(r.sched, 600);
    expect(ha.flags.enabled).toBe(true);
    r.wire.drop = (f, from) => from === 'host' && idClass(f.id) === Cls.CTRL;
    await run(r.sched, 1200);
    expect(loop.stopReason).toBe('disabled');
    r.wire.drop = null;
    await run(r.sched, 600);
    expect(a.enabled).toBe(false);
  });

  it('one-shot commands lead with a neutral command (neutral-first rule)', async () => {
    const r = await rig();
    const a = r.node({ model: Model.ESC_20A, seed: 306, num: 1 });
    const ha = await r.ready(a);
    ha.control.set('duty', 0.1);
    await run(r.sched, 2);
    expect(a.ctrl.map((c) => decodeCtrlSet(c.frame.data)?.mode)).toEqual([EscMode.OFF, EscMode.DUTY]);
    expect(a.target).toMatchObject({ mode: EscMode.DUTY });
    // After the board timed out, a lone target would be ignored; the host leads with neutral again.
    await run(r.sched, 400);
    expect(a.enabled).toBe(false);
    ha.control.set('duty', 0.15);
    await run(r.sched, 2);
    expect(a.enabled).toBe(true);
  });

  it('bus.estop sends ESTOP three times, so one lost frame does not matter', async () => {
    const r = await rig();
    const a = r.node({ model: Model.ESC_20A, seed: 307, num: 1 });
    const ha = await r.ready(a);
    ha.control.start('duty', 0.3);
    await run(r.sched, 50);
    let dropped = 0;
    r.wire.drop = (f, from) => from === 'host' && idClass(f.id) === Cls.SYS_REQ && idIndex(f.id) === SysReq.ESTOP && dropped++ === 0;
    r.bus.estop();
    await run(r.sched, 40);
    const estops = r.transport.sent.filter((f) => idClass(f.id) === Cls.SYS_REQ && idIndex(f.id) === SysReq.ESTOP);
    expect(estops).toHaveLength(ESTOP_REPEAT_COUNT);
    expect(a.estopFrames).toBe(ESTOP_REPEAT_COUNT - 1);
    expect(a.state).toBe(DeviceState.ESTOP);
  });

  it('bus.stop sends neutral to running loops before closing', async () => {
    const r = await rig();
    const a = r.node({ model: Model.ESC_20A, seed: 308, num: 1 });
    const ha = await r.ready(a);
    const reasons: ControlStopReason[] = [];
    ha.control.start('duty', 0.3, { onStopped: (x) => reasons.push(x) });
    await run(r.sched, 50);
    expect(a.enabled).toBe(true);
    await r.bus.stop();
    await run(r.sched, 5);
    expect(a.enabled).toBe(false);
    expect(reasons).toEqual(['stopped']);
  });

  it('fails a long command that the board can no longer finish (restart)', async () => {
    const r = await rig();
    const a = r.node({ model: Model.ESC_20A, seed: 309, num: 1 });
    const ha = await r.ready(a);
    a.commandScripts.set(0x40, { status: CommandStatus.OK, delayMs: 5000 });
    const p = ha.command(0x40);
    await run(r.sched, 50);
    a.powerOff();
    await run(r.sched, 100);
    a.powerOn();
    expect(await caught(settle(r.sched, p, 2000))).toMatchObject({ code: 'ABORTED', reason: 'board_reset' });
  });
});
