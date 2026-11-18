import {
  BOOT_HEARTBEAT_MAX_MS,
  BROADCAST_ALL,
  Cls,
  Command,
  CommandStatus,
  DeviceState,
  DevType,
  EscMode,
  FaultBit,
  Model,
  NUM_UNASSIGNED,
  RECOVERY_WINDOW_MS,
  STREAM_MAX_SLOTS_CLASSIC,
  StreamRsp,
  encodeAssignId,
  encodeCommand,
  encodeCtrlSet,
  encodeEstop,
  encodeStreamConfig,
  encodeStreamStart,
  messageId,
  type Address,
} from '@cygnus/protocol';
import { describe, expect, it } from 'vitest';
import type { EscNode } from '../../src/devices/esc';
import { makeDemoFirmware } from '../../src/firmware';
import { ScenarioBuilder, createScenario } from '../../src/scenarios';
import { Simulation } from '../../src/simulation';
import { MOTORS } from '../../src/world';
import { Host } from '../helpers';
import { connect, type Rig } from './harness';

const ESC: Address = { devType: DevType.MOTOR_CONTROLLER, num: 1 };
const duty = (value: number, addr: Address = ESC) => encodeCtrlSet(addr, { mode: EscMode.DUTY, flags: 0, value });
/** The neutral command: `SET` with mode 0 and value 0 (PROTOCOL §7). */
const neutral = (addr: Address = ESC) => encodeCtrlSet(addr, { mode: EscMode.OFF, flags: 0, value: 0 });
const cmd = (c: number, arg = 0, addr: Address = ESC) => encodeCommand(addr, { cmd: c, arg });

/** Host client plus a raw frame tap on the same bus and clock (for what the host API never sends). */
async function rig(id = 'bench.flywheel', fd = true): Promise<{ r: Rig; raw: Host; esc: EscNode }> {
  const sim = createScenario(id, { fd });
  const r = await connect(sim);
  const raw = new Host(sim);
  await r.discover();
  return { r, raw, esc: sim.node('esc') as EscNode };
}

/** Sends `f` every 10 ms for `ms` (a raw control loop). */
async function hold(r: Rig, raw: Host, f: ReturnType<typeof duty>, ms: number): Promise<void> {
  for (let t = 0; t < ms; t += 10) {
    raw.send(f);
    await r.runFor(10);
  }
}

async function ask(r: Rig, raw: Host, f: ReturnType<typeof cmd>): Promise<number | undefined> {
  raw.clear();
  raw.send(f);
  await r.runFor(10);
  return raw.of('commandRsp', ESC)[0]?.status;
}

describe('host ↔ simulator: PROTOCOL rules the boards enforce', () => {
  it('§4.1: the first heartbeat after start-up says BOOT within 100 ms; the host drops its cache', async () => {
    const { r, raw } = await rig();
    const d = r.dev('esc');
    await r.settle(d.setParam('vel.kp', 0.003));
    let invalidated = 0;
    d.on('paramsInvalidated', () => invalidated++);
    // A short power cut (no heartbeat is missed long enough for "lost").
    r.sim.setPower('esc', false);
    await r.runFor(100);
    r.sim.setPower('esc', true);
    raw.clear();
    const t0 = r.sim.timeMs;
    await r.until(() => raw.of('heartbeat', ESC).length > 0, 1000, 'first heartbeat');
    const first = raw.of('heartbeat', ESC)[0]!;
    expect(first.state).toBe(DeviceState.BOOT);
    expect(r.sim.timeMs - t0).toBeLessThanOrEqual(RECOVERY_WINDOW_MS + BOOT_HEARTBEAT_MAX_MS + 2);
    await r.runFor(600);
    expect(raw.of('heartbeat', ESC).slice(1).every((h) => h.state === DeviceState.IDLE)).toBe(true);
    expect(d.online).toBe(true);
    expect(invalidated).toBeGreaterThan(0);
    expect(await r.settle(d.getParam('vel.kp'))).not.toBeCloseTo(0.003, 6);
  });

  it('§7 neutral-first: a drive command counts only after a neutral one, and again after every neutral-forcing event', async () => {
    const { r, raw, esc } = await rig();
    // Fresh from boot: driving is ignored, and does not feed the watchdog either.
    await hold(r, raw, duty(0.3), 300);
    expect(esc.isEnabled()).toBe(false);
    expect(esc.faults.warn & (1 << FaultBit.CTRL_TIMEOUT)).toBe(0);
    raw.send(neutral());
    await hold(r, raw, duty(0.3), 100);
    expect(esc.isEnabled()).toBe(true);
    // CTRL timeout: the stale target does not come back on the next frame.
    await r.runFor(400);
    expect(esc.isEnabled()).toBe(false);
    await hold(r, raw, duty(0.3), 100);
    expect(esc.isEnabled()).toBe(false);
    raw.send(neutral());
    await hold(r, raw, duty(0.3), 50);
    expect(esc.isEnabled()).toBe(true);
    // ESTOP, CLEAR_ESTOP while the old target is still flowing: stays neutral.
    raw.send(encodeEstop(BROADCAST_ALL));
    await hold(r, raw, duty(0.3), 50);
    raw.send(cmd(Command.CLEAR_ESTOP));
    await hold(r, raw, duty(0.3), 200);
    expect(esc.state).toBe(DeviceState.IDLE);
    expect(esc.isEnabled()).toBe(false);
    raw.send(neutral());
    await hold(r, raw, duty(0.3), 50);
    expect(esc.isEnabled()).toBe(true);
    // An active fault forces neutral and refuses CTRL until it is gone and a neutral is seen.
    r.sim.inject('esc', 'hardware');
    await hold(r, raw, duty(0.3), 100);
    expect(esc.state).toBe(DeviceState.FAULT);
    expect(esc.isEnabled()).toBe(false);
  });

  it('§7: the host control loop starts with a neutral command, so it drives a freshly booted board', async () => {
    const { r, esc } = await rig();
    const d = r.dev('esc');
    const loop = d.control.start('duty', 0.2);
    await r.runFor(100);
    expect(esc.isEnabled()).toBe(true);
    loop.stop();
    await r.runFor(20);
    expect(esc.isEnabled()).toBe(false);
  });

  it('§7: only valid CTRL frames feed the watchdog', async () => {
    const { r, raw, esc } = await rig();
    raw.send(neutral());
    await hold(r, raw, duty(0.3), 50);
    expect(esc.isEnabled()).toBe(true);
    // Garbage at the board's CTRL address (unknown index, empty payload) every 50 ms.
    for (let t = 0; t < 600; t += 50) {
      raw.send({ id: messageId(ESC, Cls.CTRL, 5), data: new Uint8Array(0), fd: false, brs: false });
      raw.send({ id: messageId(ESC, Cls.CTRL, 0), data: new Uint8Array(3), fd: false, brs: false });
      await r.runFor(50);
    }
    expect(esc.isEnabled()).toBe(false);
    expect(esc.faults.warn & (1 << FaultBit.CTRL_TIMEOUT)).not.toBe(0);
  });

  it('§7: broadcast CTRL (NUM 0 of the type, or DEVTYPE 0) is ignored', async () => {
    const { r, raw, esc } = await rig();
    for (const addr of [{ devType: DevType.MOTOR_CONTROLLER, num: 0 }, BROADCAST_ALL]) {
      raw.send(neutral(addr));
      await hold(r, raw, duty(0.5, addr), 100);
      expect(esc.isEnabled()).toBe(false);
      expect(esc.faults.warn & (1 << FaultBit.CTRL_TIMEOUT)).toBe(0);
    }
  });

  it('§4.5: LOAD_SAVED drops unsaved changes; reset/save/load commands are DENIED while driving and REBOOT in ESTOP', async () => {
    const { r, raw, esc } = await rig();
    const d = r.dev('esc');
    const saved = await r.settle(d.getParam('vel.kp'));
    await r.settle(d.setParam('vel.kp', 0.0042));
    await r.runFor(600);
    expect(d.flags.unsaved).toBe(true);
    await r.settle(d.loadSaved());
    expect(esc.params.getKey('vel.kp')).toBeCloseTo(saved, 6);
    await r.runFor(600);
    expect(d.flags.unsaved).toBe(false);

    raw.send(neutral());
    raw.send(duty(0.2));
    await r.runFor(5);
    expect(esc.isEnabled()).toBe(true);
    for (const c of [Command.REBOOT, Command.ENTER_BOOTLOADER, Command.SAVE_PARAMS, Command.LOAD_DEFAULTS, Command.LOAD_SAVED]) {
      raw.send(duty(0.2));
      const arg = c === Command.ENTER_BOOTLOADER ? (0xb0070000 | esc.uid16) >>> 0 : 0;
      expect(await ask(r, raw, cmd(c, arg))).toBe(CommandStatus.DENIED);
    }
    expect(esc.mode).toBe(2);
    raw.send(encodeEstop(BROADCAST_ALL));
    await r.runFor(5);
    expect(await ask(r, raw, cmd(Command.REBOOT))).toBe(CommandStatus.DENIED);
    expect(await ask(r, raw, cmd(Command.ENTER_BOOTLOADER, (0xb0070000 | esc.uid16) >>> 0))).toBe(CommandStatus.DENIED);
    expect(esc.state).toBe(DeviceState.ESTOP);
    expect(await ask(r, raw, cmd(Command.CLEAR_ESTOP))).toBe(CommandStatus.OK);
    expect(await ask(r, raw, cmd(Command.ENTER_BOOTLOADER, 0))).toBe(CommandStatus.INVALID_ARG);
  });

  it('§4.7: ESTOP wins over a CLEAR_ESTOP in the same processing turn, whichever arrives first', async () => {
    const { r, raw, esc } = await rig();
    // Addressed CLEAR (higher id) after the broadcast ESTOP.
    raw.clear();
    raw.send(cmd(Command.CLEAR_ESTOP));
    raw.send(encodeEstop(BROADCAST_ALL));
    await r.runFor(5);
    expect(esc.state).toBe(DeviceState.ESTOP);
    expect(raw.of('commandRsp', ESC)[0]!.status).toBe(CommandStatus.DENIED);
    // Broadcast CLEAR (lower id) before the ESTOP.
    raw.send(encodeCommand(BROADCAST_ALL, { cmd: Command.CLEAR_ESTOP, arg: 0 }));
    raw.send(encodeEstop(BROADCAST_ALL));
    await r.runFor(5);
    expect(esc.state).toBe(DeviceState.ESTOP);
    // A later CLEAR_ESTOP releases it.
    expect(await ask(r, raw, cmd(Command.CLEAR_ESTOP))).toBe(CommandStatus.OK);
    expect(esc.state).toBe(DeviceState.IDLE);
  });

  it('§4.5: a long command running when ESTOP arrives ends with FAILED', async () => {
    const { r, raw } = await rig();
    const d = r.dev('esc');
    const p = d.selfTest();
    await r.runFor(20);
    raw.send(encodeEstop(BROADCAST_ALL));
    const e = await r.caught(p, 2000);
    expect(e).toMatchObject({ code: expect.stringMatching(/REJECTED|ABORTED/) });
    // Frame level too: SELF_TEST, ESTOP, FAILED.
    expect(await ask(r, raw, cmd(Command.CLEAR_ESTOP))).toBe(CommandStatus.OK);
    raw.clear();
    raw.send(cmd(Command.SELF_TEST));
    await r.runFor(20);
    raw.send(encodeEstop(BROADCAST_ALL));
    await r.runFor(400);
    expect(raw.of('commandRsp', ESC).map((x) => x.status)).toEqual([CommandStatus.IN_PROGRESS, CommandStatus.FAILED]);
  });

  it('§3.3: a driven board that is renumbered goes neutral and stops streaming; persistent ASSIGN is refused while driving', async () => {
    const { r, raw, esc } = await rig();
    raw.send(encodeStreamConfig(ESC, { slot: 0, sid: esc.def.signals[0]!.sid }));
    raw.send(encodeStreamStart(ESC, { period100us: 50 }));
    raw.send(neutral());
    await hold(r, raw, duty(0.2), 50);
    expect(esc.isEnabled()).toBe(true);
    expect(esc.streaming).toBe(true);
    // Persistent: refused without confirmation while driving (flash erase would stall the motor).
    raw.clear();
    raw.send(encodeAssignId(BROADCAST_ALL, { uid48: esc.uid48, newNum: 1, persist: true }));
    raw.send(duty(0.2));
    await r.runFor(20);
    expect(raw.of('enumRsp')).toHaveLength(0);
    // Not persistent, new number: neutral, stream off.
    raw.send(encodeAssignId(BROADCAST_ALL, { uid48: esc.uid48, newNum: 7, persist: false }));
    await r.runFor(5);
    expect(esc.num).toBe(7);
    expect(esc.isEnabled()).toBe(false);
    expect(esc.streaming).toBe(false);
    // The old controller keeps sending to #1: nobody answers it, and #7 needs its own neutral.
    await hold(r, raw, duty(0.2, { devType: DevType.MOTOR_CONTROLLER, num: 7 }), 50);
    expect(esc.isEnabled()).toBe(false);
  });

  it('host-sim test #1: swapping numbers under a running loop never drives the other motor', async () => {
    const sim = createScenario('all.devices');
    const r = await connect(sim);
    await r.discover();
    const a = r.dev('esc20a');
    const b = r.dev('esc80a');
    const loop = a.control.start('duty', 0.3);
    await r.runFor(200);
    expect((sim.node('esc20a') as EscNode).isEnabled()).toBe(true);
    const from = a.num;
    // The host may refuse to renumber a driven board; either way the other motor must not move.
    const attempt = async (p: Promise<unknown>): Promise<void> => {
      try {
        await r.settle(p);
      } catch {
        // refused (BUSY): fine
      }
    };
    await attempt(r.bus.assignId(a.uid48, 3, { persist: false }));
    if (a.num !== from) await attempt(r.bus.assignId(b.uid48, from, { persist: false }));
    for (let t = 0; t < 500; t += 10) {
      await r.runFor(10);
      expect((sim.node('esc80a') as EscNode).isEnabled()).toBe(false);
    }
    if (a.num !== from) expect(loop.active).toBe(false);
    loop.stop();
  });

  it('§8: classic mode streams at most 4 slots; an unknown sid keeps its slot as NaN', async () => {
    const { r, raw, esc } = await rig('bench.flywheel', false);
    const sids = esc.def.signals.slice(0, 6).map((s) => s.sid);
    sids[1] = 0x7ffe; // not in the catalog
    sids.forEach((sid, slot) => raw.send(encodeStreamConfig(ESC, { slot, sid })));
    raw.send(encodeStreamStart(ESC, { period100us: 100 }));
    await r.runFor(50);
    raw.clear();
    await r.runFor(100);
    const data = raw.frames(Cls.STREAM_RSP, StreamRsp.DATA);
    const slots = new Set(data.map((f) => f.data[1]));
    expect([...slots].sort()).toEqual([0, 1, 2, 3].slice(0, STREAM_MAX_SLOTS_CLASSIC));
    const slot1 = data.find((f) => f.data[1] === 1)!;
    expect(new DataView(slot1.data.buffer, slot1.data.byteOffset).getFloat32(4, true)).toBeNaN();
  });

  it('host-sim #5: on a saturated bus bus.estop() reaches every driven ESC within 5 ms', async () => {
    const sim = new Simulation({ seed: 3 });
    const b = new ScenarioBuilder(sim, true);
    for (let i = 0; i < 18; i++) {
      const sh = sim.world.addShaft({ id: `s${i}`, inertia: 0.002, viscous: 1e-4, coulomb: 0.02 });
      b.esc({ id: `e${i}`, model: Model.ESC_80A, motor: MOTORS.neo, shaft: sh, num: i + 1, params: { 'fb.source': 1 } });
      if (i < 5) b.encoder({ id: `c${i}`, shaft: sh, num: i + 1 });
    }
    b.gyro({ id: 'g', num: 1 });
    b.pdhLarge({ id: 'p', num: 1 });
    const r = await connect(sim);
    await r.discover();
    const escs = r.bus.devices.filter((d) => d.devType === DevType.MOTOR_CONTROLLER);
    const loops = escs.map((d) => d.control.start('duty', 0.3));
    for (const d of escs.slice(0, 2)) d.stream.open({ signals: ['velocity', 'setpoint', 'loop.output', 'phase.current', 'duty', 'bus.current'], periodUs: 1000 });
    // Plus a babbling node that keeps its own queue full of low-priority frames.
    const flood = { receive: () => undefined };
    sim.bus.attach(flood);
    const junk = new Uint8Array(8);
    for (let t = 0; t < 1000; t++) {
      for (let k = 0; k < 20; k++) sim.bus.transmit(flood, 0x1f08ffff, junk, 8, false, false);
      await r.runFor(1);
    }
    const nodes = sim.nodes.filter((n) => n.def.devType === DevType.MOTOR_CONTROLLER) as EscNode[];
    expect(nodes.filter((n) => n.isEnabled()).length).toBe(18);
    expect(sim.bus.stats.load).toBeGreaterThan(0.8);
    r.bus.estop();
    for (let t = 0; t < 5; t++) {
      for (let k = 0; k < 20; k++) sim.bus.transmit(flood, 0x1f08ffff, junk, 8, false, false);
      await r.runFor(1);
    }
    expect(nodes.filter((n) => n.estopped).length).toBe(18);
    expect(nodes.filter((n) => n.isEnabled()).length).toBe(0);
    expect(loops.every((l) => !l.active)).toBe(true);
  });

  it('§9.0: recovery mode brings back a board whose application hangs at start-up', async () => {
    const { r, raw, esc } = await rig();
    const d = r.dev('esc');
    r.sim.inject('esc', 'brokenApp');
    r.sim.powerCycle('esc');
    await r.runFor(2500);
    expect(esc.hangs).toBe(true);
    expect(d.online).toBe(false);
    r.bus.recovery.start();
    r.sim.setPower('esc', false);
    await r.runFor(100);
    r.sim.setPower('esc', true);
    await r.until(() => d.online && d.bootloader, 2000, 'board in its bootloader');
    r.bus.recovery.stop();
    expect(esc.mode).toBe(3);
    raw.clear();
    const res = await r.settle(d.firmware.update(makeDemoFirmware(Model.ESC_80A, '1.0.3', { size: 4000 })), 30_000);
    expect(res.version).toEqual({ major: 1, minor: 0, patch: 3 });
    expect(esc.hangs).toBe(false);
    expect(esc.mode).toBe(2);
  });

  it('a corrupt settings store: the board comes up unassigned with PARAM_CRC until saved or cleared', async () => {
    const { r, raw, esc } = await rig();
    r.sim.inject('esc', 'paramCrc');
    r.sim.powerCycle('esc');
    await r.runFor(400);
    expect(esc.num).toBe(NUM_UNASSIGNED);
    raw.clear();
    await r.runFor(1000);
    expect(raw.frames(Cls.SYS_RSP).filter((f) => (f.id >>> 24) === DevType.MOTOR_CONTROLLER)).toHaveLength(0);
    raw.send(encodeAssignId(BROADCAST_ALL, { uid48: esc.uid48, newNum: 1, persist: true }));
    await r.runFor(600);
    expect(esc.state).toBe(DeviceState.FAULT);
    expect(esc.faults.active & (1 << FaultBit.PARAM_CRC)).not.toBe(0);
    expect(await ask(r, raw, cmd(Command.LOAD_SAVED))).toBe(CommandStatus.FAILED);
    expect(await ask(r, raw, cmd(Command.CLEAR_FAULTS))).toBe(CommandStatus.OK);
    expect(esc.state).toBe(DeviceState.IDLE);
    expect(esc.unsaved).toBe(true);
    expect(await ask(r, raw, cmd(Command.SAVE_PARAMS))).toBe(CommandStatus.OK);
    expect(esc.unsaved).toBe(false);
    r.sim.powerCycle('esc');
    await r.runFor(400);
    expect(esc.num).toBe(1);
  });
});
