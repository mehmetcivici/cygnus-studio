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
  InfoPage,
  Model,
  NUM_UNASSIGNED,
  ParamStatus,
  PType,
  RECOVERY_WINDOW_MS,
  StreamRsp,
  decodeName,
  decodeStatusFrame,
  decodeStreamData,
  encodeAssignId,
  encodeCommand,
  encodeCtrlSet,
  encodeEnumReq,
  encodeEstop,
  encodeFaultReq,
  encodeIdentify,
  encodeIdentifyUid,
  encodeInfoReq,
  encodeName,
  encodeNameSet,
  encodeParamGet,
  encodeParamSet,
  encodeStatusFrame,
  encodeStreamConfig,
  encodeStreamStart,
  encodeStreamStop,
  enumDelayMs,
  getModel,
  hash10,
  idLow10,
  CATALOG,
} from '@cygnus/protocol';
import { describe, expect, it } from 'vitest';
import { CyncoderNode } from '../src/devices/cyncoder';
import { EscNode } from '../src/devices/esc';
import { Prng } from '../src/prng';
import { Simulation } from '../src/simulation';
import { CompiledStatusFrame } from '../src/status-codec';
import { MOTORS } from '../src/world';
import { Host } from './helpers';

const ENC = { devType: DevType.ENCODER, num: 1 };
const ESC = { devType: DevType.MOTOR_CONTROLLER, num: 1 };

function encoderSim(o: { num?: number; fd?: boolean } = {}): { sim: Simulation; host: Host; enc: CyncoderNode } {
  const sim = new Simulation({ seed: 5, fd: o.fd ?? true });
  const shaft = sim.world.addShaft({ id: 's', inertia: 0.01 });
  const enc = sim.addNode(new CyncoderNode({ id: 'enc', uid96: new Prng(9).bytes(12), num: o.num ?? 1, shaft }));
  const host = new Host(sim);
  host.run(400);
  return { sim, host, enc };
}

function escSim(params: Record<string, number> = {}): { sim: Simulation; host: Host; esc: EscNode } {
  const sim = new Simulation({ seed: 6 });
  const shaft = sim.world.addShaft({ id: 'fly', inertia: 0.004, viscous: 2e-4, coulomb: 0.03 });
  const m = sim.world.addMotor(MOTORS.neo, shaft, 1);
  const esc = sim.addNode(new EscNode(Model.ESC_80A, { id: 'esc', num: 1, motor: m, params: { 'fb.source': 1, ...params } }));
  const host = new Host(sim);
  host.run(400);
  return { sim, host, esc };
}

describe('discovery', () => {
  it('answers ENUM_REQ after its UID delay with hash10 in the id', () => {
    const { host, enc } = encoderSim();
    const r = host.ask(encodeEnumReq(BROADCAST_ALL, { filter: 0 }), 'enumRsp', 150);
    expect(r).toHaveLength(1);
    expect(r[0]!.uid48).toBe(enc.uid48);
    expect(r[0]!.num).toBe(1);
    expect(r[0]!.model).toBe(Model.CYNCODER);
    expect(idLow10(r[0]!.id)).toBe(hash10(enc.uid48));
    const delay = r[0]!.t - (host.sim.timeMs - 150);
    expect(delay).toBeGreaterThanOrEqual(enumDelayMs(enc.uid48));
    expect(delay).toBeLessThan(enumDelayMs(enc.uid48) + 3);
  });

  it('filter 1 is ignored by assigned boards and answered by unassigned ones', () => {
    const { host } = encoderSim();
    expect(host.ask(encodeEnumReq(BROADCAST_ALL, { filter: 1 }), 'enumRsp', 150)).toHaveLength(0);
    const fresh = encoderSim({ num: NUM_UNASSIGNED });
    expect(fresh.host.ask(encodeEnumReq(BROADCAST_ALL, { filter: 1 }), 'enumRsp', 150)).toHaveLength(1);
  });

  it('unassigned boards stay silent except for ENUM, ASSIGN_ID and UID IDENTIFY', () => {
    const { host, enc } = encoderSim({ num: NUM_UNASSIGNED });
    host.clear();
    host.run(1200);
    expect(host.rx).toHaveLength(0); // no heartbeat, no status
    host.send(encodeInfoReq({ devType: DevType.ENCODER, num: NUM_UNASSIGNED }, { page: 0 }));
    host.send(encodeParamGet({ devType: DevType.ENCODER, num: NUM_UNASSIGNED }, { pid: 0x100 }));
    host.run(50);
    expect(host.rx).toHaveLength(0);
    host.send(encodeIdentifyUid(BROADCAST_ALL, { uid48: enc.uid48, seconds: 3 }));
    host.run(5);
    expect(enc.identifying).toBe(true);
  });

  it('ASSIGN_ID applies, acknowledges within 50 ms, and persists only with the flag', () => {
    const { host, enc, sim } = encoderSim({ num: NUM_UNASSIGNED });
    const r = host.ask(encodeAssignId(BROADCAST_ALL, { uid48: enc.uid48, newNum: 7, persist: false }), 'enumRsp', 50);
    expect(r).toHaveLength(1);
    expect(r[0]!.num).toBe(7);
    host.run(1000);
    expect(host.of('heartbeat', { devType: DevType.ENCODER, num: 7 }).length).toBeGreaterThan(0);
    host.send(encodeCommand({ devType: DevType.ENCODER, num: 7 }, { cmd: Command.REBOOT, arg: 0 }));
    host.run(600);
    expect(enc.num).toBe(NUM_UNASSIGNED);
    host.send(encodeAssignId(BROADCAST_ALL, { uid48: enc.uid48, newNum: 9, persist: true }));
    host.run(10);
    sim.powerCycle('enc');
    host.run(600);
    expect(enc.num).toBe(9);
  });

  it('two boards on one number both fall silent; ASSIGN_ID resolves, even to the same number', () => {
    const sim = new Simulation({ seed: 2 });
    const a = sim.addNode(new CyncoderNode({ id: 'a', uid96: new Prng(1).bytes(12), num: 1 }));
    const b = sim.addNode(new CyncoderNode({ id: 'b', uid96: new Prng(2).bytes(12), num: 1 }));
    const host = new Host(sim);
    host.run(2000);
    expect(a.conflict && b.conflict).toBe(true);
    host.clear();
    host.run(1500);
    expect(host.of('heartbeat')).toHaveLength(0);
    const e = host.ask(encodeEnumReq(BROADCAST_ALL, { filter: 1 }), 'enumRsp', 150);
    expect(e.map((x) => x.conflict)).toEqual([true, true]);
    host.send(encodeAssignId(BROADCAST_ALL, { uid48: a.uid48, newNum: 1, persist: true }));
    host.send(encodeAssignId(BROADCAST_ALL, { uid48: b.uid48, newNum: 2, persist: true }));
    host.run(300);
    host.ask(encodeEnumReq(BROADCAST_ALL, { filter: 0 }), 'enumRsp', 150);
    host.clear();
    host.run(1200);
    expect(a.conflict || b.conflict).toBe(false);
    expect(host.of('heartbeat', { devType: DevType.ENCODER, num: 1 }).length).toBeGreaterThan(1);
    expect(host.of('heartbeat', { devType: DevType.ENCODER, num: 2 }).length).toBeGreaterThan(1);
  });

  it('a board joining later on a taken number silences both', () => {
    const sim = new Simulation({ seed: 3 });
    const a = sim.addNode(new CyncoderNode({ id: 'a', uid96: new Prng(4).bytes(12), num: 3 }));
    const host = new Host(sim);
    host.run(1000);
    const b = sim.addNode(new CyncoderNode({ id: 'b', uid96: new Prng(5).bytes(12), num: 3 }));
    host.run(1500);
    expect(a.conflict).toBe(true);
    expect(b.conflict).toBe(true);
  });
});

describe('heartbeat, identify, info, name', () => {
  it('sends HEARTBEAT every 500 ms with state, uid16 and firmware', () => {
    const { host, enc } = encoderSim();
    host.clear();
    host.run(2000);
    const hb = host.of('heartbeat', ENC);
    expect(hb).toHaveLength(4);
    expect(hb[1]!.t - hb[0]!.t).toBeCloseTo(500, 0);
    expect(hb[0]!.uid16).toBe(enc.uid16);
    expect(hb[0]!.state).toBe(DeviceState.IDLE);
    expect([hb[0]!.fwMajor, hb[0]!.fwMinor, hb[0]!.fwPatch]).toEqual([1, 0, 0]);
  });

  it('IDENTIFY sets the heartbeat flag and expires', () => {
    const { host } = encoderSim();
    host.send(encodeIdentify(ENC, { seconds: 1 }));
    host.clear();
    host.run(600);
    expect(host.last('heartbeat', ENC)!.identify).toBe(true);
    host.run(1000);
    expect(host.last('heartbeat', ENC)!.identify).toBe(false);
  });

  it('serves INFO pages 0..6', () => {
    const { host, enc } = encoderSim();
    const p0 = host.ask(encodeInfoReq(ENC, { page: 0 }), 'infoRsp')[0]!;
    expect(p0.section === 'device' && p0.model === Model.CYNCODER && p0.catalogRev === getModel(3)!.catalogRev).toBe(true);
    const p1 = host.ask(encodeInfoReq(ENC, { page: InfoPage.UID_LO }), 'infoRsp')[0]!;
    const p2 = host.ask(encodeInfoReq(ENC, { page: InfoPage.UID_HI }), 'infoRsp')[0]!;
    if (p1.section !== 'bytes' || p2.section !== 'bytes') throw new Error('bytes pages expected');
    expect([...p1.bytes, ...p2.bytes.subarray(0, 5)]).toEqual([...enc.uid96]);
    expect(host.ask(encodeInfoReq(ENC, { page: 3 }), 'infoRsp')[0]!.section).toBe('build');
  });

  it('NAME_SET echoes the page, sets UNSAVED, persists only after SAVE_PARAMS', () => {
    const { host, sim, enc } = encoderSim();
    const name = encodeName('Sol ön itici');
    for (let p = 0; p < 3; p++) {
      const r = host.ask(encodeNameSet(ENC, { page: p, bytes: name.slice(p * 7, p * 7 + 7) }), 'infoRsp');
      expect(r[0]!.page).toBe(4 + p);
    }
    expect(decodeName(enc.name)).toBe('Sol ön itici');
    host.clear();
    host.run(600);
    expect(host.last('heartbeat', ENC)!.unsaved).toBe(true);
    sim.powerCycle('enc');
    host.run(500);
    expect(enc.nameText).toBe('');
    for (let p = 0; p < 3; p++) host.send(encodeNameSet(ENC, { page: p, bytes: name.slice(p * 7, p * 7 + 7) }));
    host.run(5);
    expect(host.ask(encodeCommand(ENC, { cmd: Command.SAVE_PARAMS, arg: 0 }), 'commandRsp')[0]!.status).toBe(CommandStatus.OK);
    sim.powerCycle('enc');
    host.run(500);
    expect(enc.nameText).toBe('Sol ön itici');
  });
});

describe('parameters', () => {
  it('GET / SET with every status code', () => {
    const { host, esc } = escSim();
    const get = host.ask(encodeParamGet(ESC, { pid: 0x160 }), 'paramValue')[0]!;
    expect(get.status).toBe(ParamStatus.OK);
    expect(get.value).toBeCloseTo(0.002, 6);
    const set = (pid: number, ptype: number, value: number) => host.ask(encodeParamSet(ESC, { pid, ptype, value }), 'paramValue')[0]!;
    expect(set(0x160, PType.F32, 0.005).status).toBe(ParamStatus.OK);
    expect(esc.params.getKey('vel.kp')).toBeCloseTo(0.005, 6);
    expect(set(0x7777, PType.F32, 1).status).toBe(ParamStatus.UNKNOWN_PARAM);
    const mm = set(0x160, PType.U32, 1);
    expect(mm.status).toBe(ParamStatus.TYPE_MISMATCH);
    expect(mm.value).toBeCloseTo(0.005, 6); // current value returned
    expect(set(0x160, PType.F32, 5).status).toBe(ParamStatus.OUT_OF_RANGE);
    expect(set(0x0002, PType.BOOL, 1).status).toBe(ParamStatus.READ_ONLY);
    expect(set(0x0010, PType.U32, 2).status).toBe(ParamStatus.OUT_OF_RANGE); // below minNonZero
    expect(set(0x0010, PType.U32, 0).status).toBe(ParamStatus.OK);
    // lockedWhileEnabled: refuse while driving
    host.arm(ESC);
    host.send(encodeCtrlSet(ESC, { mode: EscMode.DUTY, flags: 0, value: 0.1 }));
    host.run(5);
    expect(esc.isEnabled()).toBe(true);
    expect(set(0x1a0, PType.ENUM, 2).status).toBe(ParamStatus.DENIED_WHILE_ENABLED);
  });

  it('UNSAVED bit, SAVE_PARAMS, LOAD_DEFAULTS keeps number and name', () => {
    const { host, sim, esc } = escSim();
    host.send(encodeParamSet(ESC, { pid: 0x160, ptype: PType.F32, value: 0.01 }));
    host.clear();
    host.run(600);
    expect(host.last('heartbeat', ESC)!.unsaved).toBe(true);
    host.send(encodeCommand(ESC, { cmd: Command.SAVE_PARAMS, arg: 0 }));
    host.clear();
    host.run(600);
    expect(host.last('heartbeat', ESC)!.unsaved).toBe(false);
    host.send(encodeCommand(ESC, { cmd: Command.LOAD_DEFAULTS, arg: 0 }));
    host.run(5);
    expect(esc.params.getKey('vel.kp')).toBeCloseTo(0.002, 6);
    expect(esc.num).toBe(1);
    sim.powerCycle('esc');
    host.run(500);
    expect(esc.params.getKey('vel.kp')).toBeCloseTo(0.01, 6); // flash still holds the saved value
  });

  it('can.data_bitrate is a reboot-required setting', () => {
    const { host, esc } = escSim();
    host.send(encodeParamSet(ESC, { pid: 0x0001, ptype: PType.ENUM, value: 0 }));
    host.run(5);
    expect(esc.fdMode).toBe(true);
    host.send(encodeCommand(ESC, { cmd: Command.SAVE_PARAMS, arg: 0 }));
    host.send(encodeCommand(ESC, { cmd: Command.REBOOT, arg: 0 }));
    host.run(400);
    expect(esc.fdMode).toBe(false);
  });
});

describe('status frames', () => {
  it('compiled encoder matches the catalog encoder for every model', () => {
    const rng = new Prng(1);
    for (const def of CATALOG) {
      for (const f of def.statusFrames) {
        const c = new CompiledStatusFrame(def, f);
        const sig = new Float64Array(def.signals.length);
        const rec: Record<string, number> = {};
        def.signals.forEach((s, i) => {
          const v = s.range[0] + (s.range[1] - s.range[0]) * rng.next();
          sig[i] = v;
          rec[s.key] = v;
        });
        const out = new Uint8Array(8);
        c.encode(sig, out);
        expect([...out]).toEqual([...encodeStatusFrame(f, rec)]);
      }
    }
  });

  it('sends each frame at its configured period; 0 turns it off', () => {
    const { host, esc } = escSim();
    host.clear();
    host.run(1000);
    const count = (i: number) => host.frames(Cls.STATUS, i).length;
    // Catalog default periods (they change with the bus budget, PROTOCOL §10.1).
    const per = (i: number) => esc.params.getKey(`status.${i}.period_ms`);
    for (const i of [0, 1, 4]) {
      expect(count(i)).toBeGreaterThanOrEqual(Math.floor(1000 / per(i)) - 1);
      expect(count(i)).toBeLessThanOrEqual(Math.ceil(1000 / per(i)) + 1);
    }
    host.send(encodeParamSet(ESC, { pid: 0x10, ptype: PType.U32, value: 0 }));
    host.run(5);
    host.clear();
    host.run(500);
    expect(count(0)).toBe(0);
    const f1 = host.frames(Cls.STATUS, 1).at(-1)!;
    const v = decodeStatusFrame(esc.def.statusFrames[1]!, f1.data)!;
    expect(v['bus.voltage']).toBeGreaterThan(12);
  });
});

describe('stream', () => {
  it('FD: one DATA frame carries every slot; seq counts; 500 µs minimum on the ESC', () => {
    const { host } = escSim();
    host.send(encodeStreamConfig(ESC, { slot: 0, sid: 5 }));
    host.send(encodeStreamConfig(ESC, { slot: 1, sid: 3 }));
    host.send(encodeStreamConfig(ESC, { slot: 2, sid: 1 }));
    host.send(encodeStreamStart(ESC, { period100us: 2 })); // below minimum → 500 µs
    host.run(3);
    host.clear();
    host.run(100);
    const data = host.frames(Cls.STREAM_RSP, StreamRsp.DATA).map((f) => ({ f, d: decodeStreamData(f.data)! }));
    expect(data.length).toBeGreaterThanOrEqual(199);
    expect(data.length).toBeLessThanOrEqual(201);
    expect(data[0]!.f.fd).toBe(true);
    expect(data[0]!.d.values.length).toBeGreaterThanOrEqual(3);
    expect(data[0]!.d.values[2]).toBeGreaterThan(12); // bus voltage in slot 2
    expect((data[1]!.d.seq - data[0]!.d.seq) & 0xff).toBe(1);
    expect((data[1]!.d.t100us - data[0]!.d.t100us) & 0xffff).toBe(5);
  });

  it('classic: one frame per slot; stops without keepalive after 2 s; STOP stops', () => {
    const { host, esc } = escSim({ 'can.data_bitrate': 0 });
    expect(esc.fdMode).toBe(false);
    host.send(encodeStreamConfig(ESC, { slot: 0, sid: 5 }));
    host.send(encodeStreamConfig(ESC, { slot: 1, sid: 6 }));
    host.send(encodeStreamStart(ESC, { period100us: 100 }));
    host.run(3);
    host.clear();
    host.run(100);
    const data = host.frames(Cls.STREAM_RSP).map((f) => decodeStreamData(f.data)!);
    expect(data.every((d) => d.values.length === 1)).toBe(true);
    expect(data.filter((d) => d.firstSlot === 1).length).toBeGreaterThanOrEqual(9);
    host.run(2100);
    host.clear();
    host.run(100);
    expect(host.frames(Cls.STREAM_RSP)).toHaveLength(0);
    host.send(encodeStreamStart(ESC, { period100us: 100 }));
    host.run(50);
    host.send(encodeStreamStop(ESC));
    host.run(2);
    host.clear();
    host.run(100);
    expect(host.frames(Cls.STREAM_RSP)).toHaveLength(0);
  });
});

describe('commands, faults, estop, timeout', () => {
  it('REBOOT takes the boot time; SELF_TEST answers IN_PROGRESS then the result mask', () => {
    const { host, sim } = escSim();
    expect(host.ask(encodeCommand(ESC, { cmd: Command.REBOOT, arg: 0 }), 'commandRsp')[0]!.status).toBe(CommandStatus.OK);
    host.clear();
    host.run(RECOVERY_WINDOW_MS);
    expect(host.of('heartbeat')).toHaveLength(0); // bootloader recovery window, then the app
    host.run(BOOT_HEARTBEAT_MAX_MS);
    // PROTOCOL §4.1: the first heartbeat after start-up says BOOT, within 100 ms.
    expect(host.of('heartbeat', ESC).map((h) => h.state)).toEqual([DeviceState.BOOT]);
    host.run(600);
    expect(host.last('heartbeat', ESC)!.state).toBe(DeviceState.IDLE);
    sim.inject('esc', 'selfTestFail', true, 0b100);
    const r = host.ask(encodeCommand(ESC, { cmd: Command.SELF_TEST, arg: 0 }), 'commandRsp', 400);
    expect(r.map((x) => x.status)).toEqual([CommandStatus.IN_PROGRESS, CommandStatus.OK]);
    expect(r[1]!.result).toBe(0b100);
    expect(host.ask(encodeCommand(ESC, { cmd: 0x20, arg: 0 }), 'commandRsp')[0]!.status).toBe(CommandStatus.UNSUPPORTED);
    expect(host.ask(encodeCommand(ESC, { cmd: 0x7f, arg: 0 }), 'commandRsp')[0]!.status).toBe(CommandStatus.UNSUPPORTED);
  });

  it('ESTOP latches neutral until CLEAR_ESTOP; CTRL is ignored meanwhile', () => {
    const { host, esc } = escSim();
    host.arm(ESC);
    host.send(encodeCtrlSet(ESC, { mode: EscMode.DUTY, flags: 0, value: 0.3 }));
    host.run(50);
    expect(esc.isEnabled()).toBe(true);
    host.send(encodeEstop(BROADCAST_ALL));
    host.run(3);
    expect(esc.state).toBe(DeviceState.ESTOP);
    expect(esc.isEnabled()).toBe(false);
    for (let i = 0; i < 10; i++) {
      host.send(encodeCtrlSet(ESC, { mode: EscMode.DUTY, flags: 0, value: 0.3 }));
      host.run(10);
    }
    expect(esc.isEnabled()).toBe(false);
    const f = host.ask(encodeFaultReq(ESC), 'faultRsp')[0]!;
    expect(f.active & (1 << FaultBit.ESTOP)).not.toBe(0);
    host.send(encodeCommand(ESC, { cmd: Command.CLEAR_ESTOP, arg: 0 }));
    host.run(3);
    expect(esc.state).not.toBe(DeviceState.ESTOP);
    host.send(encodeCommand(ESC, { cmd: Command.CLEAR_FAULTS, arg: 0 }));
    host.run(3);
    expect(host.ask(encodeFaultReq(ESC), 'faultRsp')[0]!.sticky).toBe(0);
  });

  it('goes neutral with a CTRL_TIMEOUT warning when commands stop', () => {
    const { host, esc } = escSim();
    host.arm(ESC);
    host.send(encodeCtrlSet(ESC, { mode: EscMode.DUTY, flags: 0, value: 0.3 }));
    host.run(150);
    expect(esc.isEnabled()).toBe(true);
    host.run(100);
    expect(esc.isEnabled()).toBe(false);
    const f = host.ask(encodeFaultReq(ESC), 'faultRsp')[0]!;
    expect(f.warn & (1 << FaultBit.CTRL_TIMEOUT)).not.toBe(0);
    host.clear();
    host.run(600);
    expect(host.last('heartbeat', ESC)!.warning).toBe(true);
  });

  it('the neutral command (mode 0, value 0) stops the motor and keeps the board fed', () => {
    const { host, esc } = escSim();
    host.arm(ESC);
    host.send(encodeCtrlSet(ESC, { mode: EscMode.DUTY, flags: 0, value: 0.3 }));
    host.run(20);
    host.send(encodeCtrlSet(ESC, { mode: 0, flags: 0, value: 0 }));
    host.run(5);
    expect(esc.isEnabled()).toBe(false);
  });
});
