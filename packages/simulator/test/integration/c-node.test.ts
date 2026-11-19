// Cross-compatibility with the real C library (firmware/cycan) through its stdin/stdout bridge
// (firmware/cycan/tools/bridge/README.md). child_process is used here only, never in the package.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import {
  BROADCAST_ALL,
  Cls,
  Command,
  CommonPid,
  DeviceState,
  DevType,
  ENTER_BOOTLOADER_INTENT,
  EscMode,
  FwStatus,
  Model,
  ManualScheduler,
  PType,
  RECOVERY_STAY_MAGIC,
  CygnusBus,
  crc32,
  decodeMessage,
  deriveUid,
  encodeAssignId,
  encodeCommand,
  encodeCtrlSet,
  encodeEnumReq,
  encodeEstop,
  encodeFaultReq,
  encodeFwBegin,
  encodeFwData,
  encodeInfoReq,
  encodeParamGet,
  encodeParamSet,
  encodeStreamConfig,
  encodeStreamStart,
  getModel,
  idClass,
  type Address,
  type CanFrame,
  type DeviceHandle,
  type TxFrame,
  type Transport,
  type TransportState,
} from '@cygnus/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { EscNode } from '../../src/devices/esc';
import { makeDemoFirmware } from '../../src/firmware';
import { Simulation } from '../../src/simulation';
import { MOTORS } from '../../src/world';
import { Host } from '../helpers';
import { flush } from './harness';

const BRIDGE = fileURLToPath(new URL('../../../../firmware/cycan/build/cycan-bridge', import.meta.url));
const HAVE_BRIDGE = existsSync(BRIDGE);
/** The bridge's default UID: byte i = 0x5A + 17·i. */
const UID96 = Uint8Array.from({ length: 12 }, (_, i) => (0x5a + 17 * i) & 0xff);
const UID = deriveUid(UID96);
const ESC: Address = { devType: DevType.MOTOR_CONTROLLER, num: 5 };
const pid = (key: string): number => getModel(Model.ESC_20A)!.params.find((p) => p.key === key)!.pid;

interface BridgeFrame {
  id: number;
  data: Uint8Array;
  fd: boolean;
  /** Virtual time the board sent it, ms. */
  t: number;
}

/** One C board behind cycan-bridge; virtual time moves only through `step`. */
class Bridge {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly waiters: Array<(line: string) => void> = [];
  readonly frames: BridgeFrame[] = [];
  readonly events: string[] = [];
  onFrame: ((f: BridgeFrame) => void) | null = null;
  now = 0;

  constructor(args: string[] = []) {
    this.child = spawn(BRIDGE, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    createInterface({ input: this.child.stdout }).on('line', (l) => this.line(l));
  }

  private line(l: string): void {
    const p = l.split(' ');
    switch (p[0]) {
      case 'F': {
        const hex = p[2] === '-' ? '' : (p[2] ?? '');
        const f: BridgeFrame = {
          id: parseInt(p[1]!, 16),
          data: Uint8Array.from(hex.match(/../g) ?? [], (h) => parseInt(h, 16)),
          fd: p[3] !== '0',
          t: Number(p[4]) / 1000,
        };
        this.frames.push(f);
        this.onFrame?.(f);
        return;
      }
      case 'T':
      case 'S':
        this.waiters.shift()?.(l);
        return;
      default:
        this.events.push(l);
    }
  }

  private write(s: string): void {
    this.child.stdin.write(`${s}\n`);
  }

  send(f: TxFrame): void {
    const hex = Array.from(f.data, (b) => b.toString(16).padStart(2, '0')).join('') || '-';
    this.write(`F ${f.id.toString(16)} ${hex}`);
  }

  power(on: boolean): void {
    this.write(`P ${on ? 1 : 0}`);
  }

  async step(ms: number): Promise<void> {
    const done = new Promise<string>((res) => this.waiters.push(res));
    this.write(`T ${Math.round(ms * 1000)}`);
    const l = await done;
    this.now = Number(l.split(' ')[1]) / 1000;
  }

  close(): void {
    this.write('Q');
    this.child.stdin.end();
  }
}

/** The bridge as a host Transport (a USB-CAN adapter in front of one C board). */
class BridgeTransport implements Transport {
  readonly info = { kind: 'c-bridge', label: 'cycan-bridge', fd: true };
  private readonly frameCbs = new Set<(f: CanFrame) => void>();
  private readonly stateCbs = new Set<(s: TransportState) => void>();
  private phase: TransportState['phase'] = 'closed';

  constructor(private readonly bridge: Bridge) {
    bridge.onFrame = (f) => {
      const frame: CanFrame = { id: f.id, data: f.data, fd: f.fd, brs: f.fd, timestamp: f.t };
      for (const cb of this.frameCbs) cb(frame);
    };
  }

  get state(): TransportState {
    return { phase: this.phase };
  }

  async open(): Promise<void> {
    this.phase = 'open';
    for (const cb of this.stateCbs) cb(this.state);
  }

  async close(): Promise<void> {
    this.phase = 'closed';
    for (const cb of this.stateCbs) cb(this.state);
  }

  send(f: Omit<CanFrame, 'timestamp'>): void {
    if (this.phase === 'open') this.bridge.send(f);
  }

  onFrame(cb: (f: CanFrame) => void): () => void {
    this.frameCbs.add(cb);
    return () => this.frameCbs.delete(cb);
  }

  onState(cb: (s: TransportState) => void): () => void {
    this.stateCbs.add(cb);
    cb(this.state);
    return () => this.stateCbs.delete(cb);
  }
}

interface CRig {
  bridge: Bridge;
  bus: CygnusBus;
  transport: BridgeTransport;
  runFor(ms: number): Promise<void>;
  settle<T>(p: Promise<T>, maxMs?: number): Promise<T>;
  until(cond: () => boolean, maxMs?: number, what?: string): Promise<void>;
  caught(p: Promise<unknown>, maxMs?: number): Promise<unknown>;
  /** The C board, once discovered and numbered 5 (persistently). */
  board(): Promise<DeviceHandle>;
}

const open: Bridge[] = [];
afterEach(() => {
  for (const b of open.splice(0)) b.close();
});

/** Host CygnusBus and the C board on one virtual clock: host timers, then 1 ms of board time. */
async function cRig(args: string[] = []): Promise<CRig> {
  const bridge = new Bridge(args);
  open.push(bridge);
  const sched = new ManualScheduler(0);
  const transport = new BridgeTransport(bridge);
  const bus = new CygnusBus(transport, sched, { drivers: [] });
  await bus.start();
  const step = async (): Promise<void> => {
    sched.advance(1);
    await bridge.step(1);
    await flush();
  };
  const runFor = async (ms: number): Promise<void> => {
    for (let t = 0; t < ms; t++) await step();
  };
  const settle = async <T,>(p: Promise<T>, maxMs = 30_000): Promise<T> => {
    let done = false;
    const tracked = p.then(
      (v) => ((done = true), v),
      (e: unknown) => {
        done = true;
        throw e;
      },
    );
    tracked.catch(() => undefined);
    await flush();
    for (let t = 0; t < maxMs && !done; t++) await step();
    if (!done) throw new Error(`promise did not settle within ${maxMs} ms`);
    return tracked;
  };
  const until = async (cond: () => boolean, maxMs = 5000, what = 'condition'): Promise<void> => {
    for (let t = 0; t < maxMs && !cond(); t++) await step();
    if (!cond()) throw new Error(`${what} not reached within ${maxMs} ms`);
  };
  return {
    bridge,
    bus,
    transport,
    runFor,
    settle,
    until,
    async caught(p, maxMs = 30_000) {
      try {
        await settle(p, maxMs);
      } catch (e) {
        return e;
      }
      throw new Error('expected rejection');
    },
    async board() {
      await until(() => bus.devices.length === 1, 3000, 'discovery');
      const d = bus.devices[0]!;
      if (d.unassigned) await settle(bus.assignId(d.uid48, 5, { persist: true }));
      await until(() => d.online && d.infoLoaded && d.fw !== null, 3000, 'INFO');
      return d;
    },
  };
}

describe('host ↔ C library (cycan-bridge)', () => {
  it.skipIf(!HAVE_BRIDGE)('discovery, ASSIGN_ID and INFO', async () => {
    const r = await cRig();
    await r.until(() => r.bus.devices.length === 1, 3000, 'discovery');
    const d = r.bus.devices[0]!;
    expect(d.unassigned).toBe(true);
    expect(d.uid48).toBe(UID.uid48.toString(16).padStart(12, '0'));
    await r.settle(r.bus.assignId(d.uid48, 5, { persist: true }));
    await r.until(() => d.online && d.infoLoaded && d.fw !== null, 3000, 'INFO and heartbeat');
    expect(d.num).toBe(5);
    expect(d.model).toBe(Model.ESC_20A);
    expect(d.hwRev).toBe(1);
    expect(d.catalogRev).toBe(getModel(Model.ESC_20A)!.catalogRev);
    expect(d.uid96).toBe(Array.from(UID96, (b) => b.toString(16).padStart(2, '0')).join(''));
    expect(d.fw).toEqual({ major: 1, minor: 0, patch: 0 });
  });

  it.skipIf(!HAVE_BRIDGE)('parameters, name, SAVE and reboot (settings survive; BOOT heartbeat drops the cache)', async () => {
    const r = await cRig();
    const d = await r.board();
    expect(await r.settle(d.getParam('ctrl.timeout_ms'))).toBe(200);
    await r.settle(d.setParam('vel.kp', 0.0025));
    const all = await r.settle(d.readAllParams());
    expect(all.failed).toEqual([]);
    await r.settle(d.rename('Sol on itici'));
    await r.settle(d.save());
    await r.runFor(600);
    expect(d.flags.unsaved).toBe(false);
    let invalidated = 0;
    d.on('paramsInvalidated', () => invalidated++);
    await r.settle(d.reboot());
    await r.until(() => d.online && d.state === DeviceState.IDLE && d.infoLoaded, 3000, 'back after reboot');
    expect(invalidated).toBeGreaterThan(0);
    expect(await r.settle(d.getParam('vel.kp'))).toBeCloseTo(0.0025, 7);
    expect(d.name).toBe('Sol on itici');
    // LOAD_SAVED drops a RAM change.
    await r.settle(d.setParam('vel.kp', 0.004));
    await r.settle(d.loadSaved());
    expect(await r.settle(d.getParam('vel.kp'))).toBeCloseTo(0.0025, 7);
  });

  it.skipIf(!HAVE_BRIDGE)('1 kHz stream without loss', async () => {
    const r = await cRig();
    const d = await r.board();
    const sub = d.stream.open({ signals: ['setpoint', 'duty'], periodUs: 1000 });
    await r.runFor(2500); // across a keepalive
    expect(sub.samples).toBeGreaterThan(2000);
    expect(sub.lost).toBe(0);
    sub.close();
  });

  it.skipIf(!HAVE_BRIDGE)('CTRL: neutral-first, the host loop, and the timeout to neutral', async () => {
    const r = await cRig();
    const d = await r.board();
    // A raw drive command before any neutral one is ignored.
    for (let t = 0; t < 10; t++) {
      r.transport.send(encodeCtrlSet(ESC, { mode: EscMode.DUTY, flags: 0, value: 0.3 }));
      await r.runFor(20);
    }
    await r.runFor(600);
    expect(d.flags.enabled).toBe(false);
    const loop = d.control.start('duty', 0.3);
    await r.runFor(600);
    expect(d.flags.enabled).toBe(true);
    expect(d.state).toBe(DeviceState.ACTIVE);
    loop.stop();
    await r.runFor(600);
    expect(d.flags.enabled).toBe(false);
    // The loop ended with the neutral command: silence afterwards is not a timeout (PROTOCOL §7).
    expect(d.flags.warning).toBe(false);
    d.control.set('duty', 0.2);
    await r.runFor(800);
    expect(d.flags.enabled).toBe(false);
    expect(d.flags.warning).toBe(true);
  });

  it.skipIf(!HAVE_BRIDGE)('abortAction(): a neutral CTRL cancels a running moving command with FAILED (PROTOCOL §4.5)', async () => {
    const r = await cRig();
    const d = await r.board();
    const p = d.command('measure_motor');
    await r.runFor(100);
    d.abortAction();
    expect(await r.caught(p, 200)).toMatchObject({ code: 'REJECTED', status: 5 });
    expect(r.bridge.events).toContain('N ABORT');
    await r.runFor(600);
    expect(d.flags.enabled).toBe(false);
    await r.settle(d.command(Command.SELF_TEST));
  });

  it.skipIf(!HAVE_BRIDGE)('ESTOP latches; CLEAR_ESTOP releases it', async () => {
    const r = await cRig();
    const d = await r.board();
    const loop = d.control.start('duty', 0.3);
    await r.runFor(100);
    r.bus.estop();
    await r.runFor(600);
    expect(d.state).toBe(DeviceState.ESTOP);
    expect(loop.active).toBe(false);
    await r.settle(d.clearEstop());
    await r.runFor(600);
    expect(d.state).toBe(DeviceState.IDLE);
  });

  it.skipIf(!HAVE_BRIDGE)('firmware update through the C bootloader; settings survive', async () => {
    const r = await cRig();
    const d = await r.board();
    await r.settle(d.setParam('vel.kp', 0.0031));
    await r.settle(d.save());
    const res = await r.settle(d.firmware.update(makeDemoFirmware(Model.ESC_20A, '1.3.0', { size: 4000 })), 60_000);
    expect(res.version).toEqual({ major: 1, minor: 3, patch: 0 });
    await r.until(() => d.infoLoaded && d.state === DeviceState.IDLE, 3000, 'app back');
    expect(await r.settle(d.getParam('vel.kp'))).toBeCloseTo(0.0031, 7);
  });

  it.skipIf(!HAVE_BRIDGE)('a wrong-model image is refused at its header; the installed application stays', async () => {
    const r = await cRig();
    const d = await r.board();
    // Make the host believe it is an ESC 80A so its own model check lets the image through.
    (d as unknown as { model: number }).model = Model.ESC_80A;
    const e = await r.caught(d.firmware.update(makeDemoFirmware(Model.ESC_80A, '3.0.0', { size: 4000 })));
    expect(e).toMatchObject({ code: 'REJECTED', status: FwStatus.BAD_IMAGE });
    (d as unknown as { model: number }).model = Model.ESC_20A;
    await r.runFor(1200);
    expect(d.fw).toEqual({ major: 1, minor: 0, patch: 0 });
  });

  it.skipIf(!HAVE_BRIDGE)('recovery window: the boot-time beacon keeps the C bootloader', async () => {
    const r = await cRig();
    const d = await r.board();
    r.bus.recovery.start();
    r.bridge.power(false);
    await r.runFor(50);
    r.bridge.power(true);
    await r.until(() => d.online && d.state === DeviceState.BOOTLOADER, 3000, 'bootloader');
    r.bus.recovery.stop();
    await r.settle(d.reboot());
    await r.until(() => d.state === DeviceState.IDLE, 3000, 'application');
  });
});

// ---- Differential test: the same frames to the simulated board and to the C board ----------

interface Step {
  /** Time to send, ms (both boards start powered at t = 0). */
  at: number;
  frames: TxFrame[];
  label: string;
}

/** Frames of a session covering discovery, INFO, parameters, commands, CTRL, ESTOP and the bootloader. */
function script(): Step[] {
  const s: Step[] = [];
  let at = 300;
  const add = (label: string, ...frames: TxFrame[]): void => {
    s.push({ at, frames, label });
    at += 40;
  };
  const cmd = (c: number, arg = 0, addr: Address = ESC) => encodeCommand(addr, { cmd: c, arg });
  const drive = (v: number) => encodeCtrlSet(ESC, { mode: EscMode.DUTY, flags: 0, value: v });
  const neutral = encodeCtrlSet(ESC, { mode: EscMode.OFF, flags: 0, value: 0 });
  add('enum all', encodeEnumReq(BROADCAST_ALL, { filter: 0 }));
  at += 100;
  add('enum unassigned', encodeEnumReq(BROADCAST_ALL, { filter: 1 }));
  at += 100;
  add('assign 5', encodeAssignId(BROADCAST_ALL, { uid48: UID.uid48, newNum: 5, persist: true }));
  for (const page of [0, 1, 2, 4, 9]) add(`info ${page}`, encodeInfoReq(ESC, { page }));
  add('get timeout', encodeParamGet(ESC, { pid: CommonPid.CTRL_TIMEOUT_MS }));
  add('get bitrate', encodeParamGet(ESC, { pid: CommonPid.CAN_DATA_BITRATE }));
  add('get unknown', encodeParamGet(ESC, { pid: 0x7777 }));
  add('set kp', encodeParamSet(ESC, { pid: pid('vel.kp'), ptype: PType.F32, value: 0.0025 }));
  add('set kp type mismatch', encodeParamSet(ESC, { pid: pid('vel.kp'), ptype: PType.U32, value: 1 }));
  add('set timeout out of range', encodeParamSet(ESC, { pid: CommonPid.CTRL_TIMEOUT_MS, ptype: PType.U32, value: 5 }));
  add('set termination read-only', encodeParamSet(ESC, { pid: CommonPid.CAN_TERMINATION, ptype: PType.BOOL, value: 1 }));
  add('save', cmd(Command.SAVE_PARAMS));
  add('set kp again', encodeParamSet(ESC, { pid: pid('vel.kp'), ptype: PType.F32, value: 0.004 }));
  add('load saved', cmd(Command.LOAD_SAVED));
  add('get kp', encodeParamGet(ESC, { pid: pid('vel.kp') }));
  add('enter bootloader without intent', cmd(Command.ENTER_BOOTLOADER, 0));
  add('unknown command', cmd(0x20));
  add('drive before neutral', drive(0.3));
  add('fault req', encodeFaultReq(ESC));
  add('broadcast neutral + drive', encodeCtrlSet({ devType: DevType.MOTOR_CONTROLLER, num: 0 }, { mode: 0, flags: 0, value: 0 }), encodeCtrlSet({ devType: DevType.MOTOR_CONTROLLER, num: 0 }, { mode: EscMode.DUTY, flags: 0, value: 0.3 }));
  add('neutral + drive', neutral, drive(0.3));
  add('save while driving', drive(0.3), cmd(Command.SAVE_PARAMS));
  add('load defaults while driving', drive(0.3), cmd(Command.LOAD_DEFAULTS));
  add('reboot while driving', drive(0.3), cmd(Command.REBOOT));
  add('persistent assign while driving (refused, no reply)', drive(0.3), encodeAssignId(BROADCAST_ALL, { uid48: UID.uid48, newNum: 5, persist: true }));
  add('renumber while driving', drive(0.3), encodeAssignId(BROADCAST_ALL, { uid48: UID.uid48, newNum: 6, persist: false }));
  add('drive at the new number without neutral', encodeCtrlSet({ devType: DevType.MOTOR_CONTROLLER, num: 6 }, { mode: EscMode.DUTY, flags: 0, value: 0.3 }), encodeFaultReq({ devType: DevType.MOTOR_CONTROLLER, num: 6 }));
  add('number back', encodeAssignId(BROADCAST_ALL, { uid48: UID.uid48, newNum: 5, persist: false }));
  add('neutral + drive again', neutral, drive(0.3));
  at += 400; // CTRL timeout
  add('fault req after timeout', encodeFaultReq(ESC));
  add('drive, end with neutral', neutral, drive(0.3), neutral);
  at += 400; // silence after the neutral command: no CTRL_TIMEOUT warning
  add('fault req after a normal end', encodeFaultReq(ESC));
  add('neutral + drive, then lost', neutral, drive(0.3));
  at += 400;
  add('fault req after the loss', encodeFaultReq(ESC));
  add('estop', encodeEstop(BROADCAST_ALL));
  add('reboot in estop', cmd(Command.REBOOT));
  add('clear estop in the same turn', encodeEstop(BROADCAST_ALL), cmd(Command.CLEAR_ESTOP));
  add('clear estop', cmd(Command.CLEAR_ESTOP));
  add('clear faults', cmd(Command.CLEAR_FAULTS));
  add('fault req after clear', encodeFaultReq(ESC));
  // PROTOCOL §4.5: a neutral CTRL cancels a running moving command, so does the CTRL timeout.
  add('measure motor', cmd(0x41));
  add('neutral cancels the moving command', neutral);
  add('measure motor again', cmd(0x41));
  at += 400;
  add('fault req after the timeout cancelled it', encodeFaultReq(ESC));
  add('recovery beacon to a running app', encodeCommand(BROADCAST_ALL, { cmd: Command.ENTER_BOOTLOADER, arg: RECOVERY_STAY_MAGIC }));
  add('enter bootloader', cmd(Command.ENTER_BOOTLOADER, (ENTER_BOOTLOADER_INTENT | UID.uid16) >>> 0));
  at += 300;
  add('bootloader info 0', encodeInfoReq(ESC, { page: 0 }));
  add('bootloader info 3 (silent)', encodeInfoReq(ESC, { page: 3 }));
  add('bootloader param (silent)', encodeParamGet(ESC, { pid: CommonPid.CTRL_TIMEOUT_MS }));
  const wrong = makeDemoFirmware(Model.ESC_80A, '2.0.0', { size: 600 });
  add('wrong-model begin', encodeFwBegin(ESC, { size: wrong.length, crc32: crc32(wrong) }));
  add('wrong-model header', encodeFwData(ESC, { offset: 0, bytes: wrong.slice(0, 61) }), encodeFwData(ESC, { offset: 61, bytes: wrong.slice(61, 122) }));
  add('reboot from bootloader', cmd(Command.REBOOT));
  at += 400;
  add('info after restart', encodeInfoReq(ESC, { page: 0 }));
  return s;
}

/** Board replies worth comparing: everything except periodic STATUS/STREAM and heartbeats. */
function replies(frames: Array<{ id: number; data: Uint8Array; t: number }>, from: number, to: number): string[] {
  return frames
    // The C bootloader answers within the same virtual ms it got the frame: [from, to).
    .filter((f) => f.t >= from && f.t < to && idClass(f.id) !== Cls.STATUS && idClass(f.id) !== Cls.STREAM_RSP)
    .map((f) => ({ f, m: decodeMessage(f.id, f.data) }))
    .filter(({ m }) => m?.kind !== 'heartbeat')
    .map(({ f, m }) => `${f.id.toString(16)} ${m ? JSON.stringify(m) : Array.from(f.data, (b) => b.toString(16).padStart(2, '0')).join('')}`);
}

/** Last heartbeat at or before `t`: state and flags (timing aside, both boards must agree). */
function heartbeatAt(frames: Array<{ id: number; data: Uint8Array; t: number }>, t: number): string {
  for (let i = frames.length - 1; i >= 0; i--) {
    const f = frames[i]!;
    if (f.t > t) continue;
    const m = decodeMessage(f.id, f.data);
    if (m?.kind === 'heartbeat') return JSON.stringify({ state: m.state, unsaved: m.unsaved, enabled: m.enabled, warning: m.warning, fault: m.fault, fw: [m.fwMajor, m.fwMinor, m.fwPatch] });
  }
  return 'none';
}

describe('simulated board ≡ C board (differential)', () => {
  it.skipIf(!HAVE_BRIDGE)('the same frames give the same replies', async () => {
    const steps = script();
    const end = steps.at(-1)!.at + 100;

    const sim = new Simulation({ seed: 1 });
    const shaft = sim.world.addShaft({ id: 'flywheel', inertia: 0.004, viscous: 2e-4, coulomb: 0.03 });
    sim.addNode(new EscNode(Model.ESC_20A, { id: 'esc', uid96: UID96, motor: sim.world.addMotor(MOTORS.neo550, shaft, 1) }));
    const host = new Host(sim);
    const simFrames: Array<{ id: number; data: Uint8Array; t: number }> = [];
    host.transport.onFrame((f) => simFrames.push({ id: f.id, data: f.data, t: f.timestamp }));

    const bridge = new Bridge();
    open.push(bridge);

    let k = 0;
    for (let t = 0; t < end; t++) {
      while (k < steps.length && steps[k]!.at === t) {
        for (const f of steps[k]!.frames) {
          host.send(f);
          bridge.send(f);
        }
        k++;
      }
      sim.advance(1);
      await bridge.step(1);
    }

    const diffs: string[] = [];
    for (let i = 0; i < steps.length; i++) {
      const from = steps[i]!.at;
      const to = steps[i + 1]?.at ?? end;
      const a = replies(simFrames, from, to);
      const b = replies(bridge.frames, from, to);
      if (JSON.stringify(a) !== JSON.stringify(b)) diffs.push(`${steps[i]!.label}:\n  sim ${a.join('\n      ')}\n  C   ${b.join('\n      ')}`);
      const ha = heartbeatAt(simFrames, to);
      const hb = heartbeatAt(bridge.frames, to);
      if (ha !== hb) diffs.push(`${steps[i]!.label} (heartbeat):\n  sim ${ha}\n  C   ${hb}`);
    }
    expect(diffs.join('\n')).toBe('');
    // Sanity: the session really ran (both sides answered the bootloader REBOOT).
    expect(replies(simFrames, 0, end).length).toBeGreaterThan(30);
  });
});
