import { actionByCmd, getModel, paramById, signalBySid } from '../../src/catalog/catalog';
import type { ModelDef } from '../../src/catalog/schema';
import { encodeStatusFrame } from '../../src/catalog/status';
import { checkParamValue, quantizeParamValue } from '../../src/catalog/values';
import {
  BOOT_HEARTBEAT_MAX_MS,
  Cls,
  Command,
  CommandStatus,
  DeviceState,
  ENTER_BOOTLOADER_INTENT,
  ESTOP_MAGIC_0,
  ESTOP_MAGIC_1,
  FW_WINDOW_DEFAULT,
  FaultBit,
  FwReq,
  FwStatus,
  InfoPage,
  NUM_UNASSIGNED,
  ParamReq,
  ParamStatus,
  RECOVERY_STAY_MAGIC,
  RECOVERY_WINDOW_MS,
  StreamReq,
  SysReq,
  SysRsp,
} from '../../src/core/constants';
import { crc32 } from '../../src/core/crc32';
import { CYFW_HEADER_SIZE, decodeCyfwHeader } from '../../src/core/cyfw';
import { deriveUid } from '../../src/core/fnv';
import type { Address, CanFrame, TxFrame } from '../../src/core/frame';
import { acceptsFrame, idClass, idDevType, idIndex, idNum, isCyCanId } from '../../src/core/id';
import {
  decodeAssignId,
  decodeCommand,
  decodeCtrlServo,
  decodeCtrlSet,
  decodeEnumReq,
  decodeFwBegin,
  decodeFwData,
  decodeHeartbeat,
  decodeIdentify,
  decodeInfoReq,
  decodeNameSet,
  decodeParamGet,
  decodeParamSet,
  decodeStreamConfig,
  decodeStreamStart,
  encodeCommandRsp,
  encodeEnumRsp,
  encodeFaultRsp,
  encodeFwAck,
  encodeHeartbeat,
  encodeInfoRsp,
  encodeParamValue,
  encodeStatus,
  encodeStreamData,
  uid96ToInfoPages,
} from '../../src/core/messages';
import { decodeName, encodeName } from '../../src/core/text';
import type { ManualScheduler } from '../../src/transport/scheduler';
import type { BusNode, FakeBus } from './fake-bus';

export interface FakeNodeOptions {
  model: number;
  /** Seed for a deterministic 96-bit UID. */
  seed: number;
  num?: number;
  fw?: [number, number, number];
  hwRev?: number;
  catalogRev?: number;
  name?: string;
  /** Board sends FD frames (can.data_bitrate != 0). Default true. */
  fd?: boolean;
  bootloader?: boolean;
  /** Send catalog STATUS frames at their default periods. */
  status?: boolean;
}

export interface CommandScript {
  status: number;
  result?: number;
  /** IN_PROGRESS first, the final answer after this many ms. */
  delayMs?: number;
}

export function uidFromSeed(seed: number): Uint8Array {
  const u = new Uint8Array(12);
  let x = (seed * 2654435761) >>> 0 || 1;
  for (let i = 0; i < 12; i++) {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    u[i] = x & 0xff;
  }
  return u;
}

/**
 * Scripted CyCAN board following docs/PROTOCOL.md closely enough to exercise the host:
 * discovery with UID-derived delays, conflict detection, BOOT heartbeat, INFO, params,
 * commands (DENIED while driven or in ESTOP, ENTER_BOOTLOADER intent), faults, STATUS,
 * streaming (FD and classic), CTRL with the neutral-first rule and timeout, and a bootloader
 * with a recovery window, header check before erase and windowed firmware transfer.
 */
export class FakeNode implements BusNode {
  readonly def: ModelDef;
  readonly uid96: Uint8Array;
  readonly uid48: number;
  readonly uid16: number;
  readonly enumDelay: number;
  readonly devType: number;
  num: number;
  conflict = false;
  state: number = DeviceState.IDLE;
  fw: [number, number, number];
  hwRev: number;
  catalogRev: number;
  name: Uint8Array;
  fd: boolean;
  identifySeconds = 0;
  enabled = false;
  unsaved = false;
  faults = { active: 0, sticky: 0, warn: 0 };
  params = new Map<number, number>();
  saved = new Map<number, number>();
  signalValues: Record<string, number> = {};
  persistedNum: number | null = null;
  received: CanFrame[] = [];
  /** Every CTRL frame addressed to this board; `accepted` when it drove (or neutralised) the board. */
  ctrl: Array<{ t: number; frame: CanFrame; accepted: boolean }> = [];
  powered = true;
  /** Neutral-first rule: a neutral command was seen since the last forced neutral. */
  armed = false;
  /** Last accepted non-neutral command, e.g. `{ mode: 1, value: 0.3 }`. */
  target: { mode: number; value: number } | null = null;

  // Scripting hooks
  /** Drop the next N PARAM GET requests (to test retries). */
  dropParamGets = 0;
  /** Do not answer at all for these classes. */
  mute = new Set<number>();
  commandScripts = new Map<number, CommandScript>();
  selfTestMask = 0;
  /** Stream sample value per sid and sequence number. */
  streamValue: (sid: number, seq: number) => number = (sid, seq) => sid * 100 + seq;
  /** Skip sending samples whose seq makes this true (loss test). */
  streamSkip: (seq: number) => boolean = () => false;
  /** Drop the DATA frame at this offset once (BAD_OFFSET test). */
  fwDropOffsetOnce: number | null = null;
  /** Flip a byte at this offset as it is received (BAD_CRC test). */
  fwCorruptOffset: number | null = null;
  /** Erase time after the header was accepted (the board answers BUSY meanwhile). */
  fwBeginBusyMs = 30;
  fwWindow = FW_WINDOW_DEFAULT;
  /** Version the board reports after flashing; null = take it from the image header. */
  fwVersionAfterUpdate: [number, number, number] | null = null;
  /** Go BUSY for `ms` when DATA reaches this offset, then continue (flash work mid-transfer). */
  fwBusyAt: { offset: number; ms: number } | null = null;
  /** Drop the ACK to the next N END frames (END-ACK loss test). */
  fwDropEndAcks = 0;
  /** Drop the next N COMMAND_RSP frames for ENTER_BOOTLOADER (the command is still carried out). */
  dropEnterBootloaderRsp = 0;
  /** Ignore the next N ENTER_BOOTLOADER commands entirely. */
  ignoreEnterBootloader = 0;
  /** The application never comes up (crashes at start); only the recovery window can catch the board. */
  appBroken = false;

  private timers = new Set<unknown>();
  private hbTimer: unknown = undefined;
  private statusTimers: unknown[] = [];
  // stream
  private slots: number[] = [];
  private streamPeriod = 0;
  private streamTimer: unknown = undefined;
  private streamDeadline = 0;
  private seq = 0;
  // firmware
  private fwBuf: Uint8Array | null = null;
  private fwSize = 0;
  private fwCrc = 0;
  private fwExpected = 0;
  private fwCount = 0;
  /** 'header': collecting the 64-byte header · 'erase': BUSY · 'data' · 'verify': after END. */
  private fwPhase: 'idle' | 'header' | 'erase' | 'data' | 'verify' = 'idle';
  private ctrlTimer: unknown = undefined;
  private recoveryUntil = -1;

  constructor(
    private readonly bus: FakeBus,
    opts: FakeNodeOptions,
  ) {
    const def = getModel(opts.model);
    if (!def) throw new Error(`no model ${opts.model}`);
    this.def = def;
    this.devType = def.devType;
    this.uid96 = uidFromSeed(opts.seed);
    const d = deriveUid(this.uid96);
    this.uid48 = d.uid48;
    this.uid16 = d.uid16;
    this.enumDelay = d.enumDelayMs;
    this.num = opts.num ?? NUM_UNASSIGNED;
    this.fw = opts.fw ?? [1, 0, 0];
    this.hwRev = opts.hwRev ?? 1;
    this.catalogRev = opts.catalogRev ?? def.catalogRev;
    this.name = encodeName(opts.name ?? '');
    this.fd = opts.fd ?? true;
    if (opts.bootloader) this.state = DeviceState.BOOTLOADER;
    for (const p of def.params) this.params.set(p.pid, p.default);
    this.saved = new Map(this.params);
    for (const s of def.signals) this.signalValues[s.key] = s.sid;
    bus.attach(this);
    this.startHeartbeat();
    if (opts.status) this.startStatus();
  }

  get sched(): ManualScheduler {
    return this.bus.scheduler;
  }

  get address(): Address {
    return { devType: this.devType, num: this.num };
  }

  get resolved(): boolean {
    return this.num !== NUM_UNASSIGNED && this.num !== 0 && !this.conflict;
  }

  get inBootloader(): boolean {
    return this.state === DeviceState.BOOTLOADER;
  }

  param(key: string): number | undefined {
    const p = this.def.params.find((x) => x.key === key);
    return p ? this.params.get(p.pid) : undefined;
  }

  /** Removes power: stops every timer and stops answering. */
  powerOff(): void {
    this.powered = false;
    this.stopTimers();
  }

  /**
   * Power returns: RAM is reset. The bootloader listens for the recovery beacon first
   * (PROTOCOL §9.0), then the application starts with a BOOT heartbeat (§4.1).
   */
  powerOn(): void {
    this.powered = true;
    this.resetRam();
    if (this.inBootloader) {
      this.startHeartbeat();
      return;
    }
    this.state = DeviceState.BOOT;
    this.recoveryUntil = this.sched.now() + RECOVERY_WINDOW_MS;
    this.later(RECOVERY_WINDOW_MS, () => {
      this.recoveryUntil = -1;
      if (this.inBootloader) return;
      this.startApp();
    });
  }

  private resetRam(): void {
    this.params = new Map(this.saved);
    this.unsaved = false;
    this.disarm();
    this.slots = [];
    this.conflict = false;
    this.fwPhase = 'idle';
    this.fwBuf = null;
  }

  /** Application start: first heartbeat (state BOOT) within 100 ms, then the usual 2 Hz. */
  private startApp(): void {
    if (this.appBroken) {
      this.state = DeviceState.BOOT;
      return;
    }
    this.state = DeviceState.BOOT;
    this.later(Math.min(BOOT_HEARTBEAT_MAX_MS, 20 + (this.uid48 % 51)), () => {
      if (this.resolved) this.send(this.heartbeatFrame());
      this.state = DeviceState.IDLE;
      this.startHeartbeat();
    });
  }

  /** Forces the actuator neutral; it needs a neutral command before it drives again. */
  private disarm(): void {
    this.enabled = false;
    this.armed = false;
    this.target = null;
    this.cancel(this.ctrlTimer);
    this.ctrlTimer = undefined;
  }

  /** Detaches from the bus and cancels every timer. */
  destroy(): void {
    this.powerOff();
    this.bus.detach(this);
  }

  // ---------------------------------------------------------------------------------------

  private send(f: TxFrame): void {
    if (this.powered) this.bus.fromNode(this, f);
  }

  private later(ms: number, fn: () => void): unknown {
    const h = this.sched.setTimeout(() => {
      this.timers.delete(h);
      if (this.powered) fn();
    }, ms);
    this.timers.add(h);
    return h;
  }

  private cancel(h: unknown): void {
    if (h === undefined) return;
    this.sched.clearTimeout(h);
    this.timers.delete(h);
  }

  private stopTimers(): void {
    for (const h of this.timers) this.sched.clearTimeout(h);
    this.timers.clear();
    this.hbTimer = undefined;
    this.streamTimer = undefined;
    this.ctrlTimer = undefined;
    this.statusTimers = [];
  }

  private startHeartbeat(): void {
    this.cancel(this.hbTimer);
    const phase = this.uid48 % 51;
    const beat = (): void => {
      if (this.resolved) this.send(this.heartbeatFrame());
      this.hbTimer = this.later(500, beat);
    };
    this.hbTimer = this.later(phase, beat);
  }

  heartbeatFrame(): TxFrame {
    return encodeHeartbeat(this.address, {
      state: this.state,
      unsaved: this.unsaved,
      enabled: this.enabled,
      warning: this.faults.warn !== 0,
      identify: this.identifySeconds > 0,
      fault: this.faults.active,
      uid16: this.uid16,
      fwMajor: this.fw[0],
      fwMinor: this.fw[1],
      fwPatch: this.fw[2],
    });
  }

  private startStatus(): void {
    for (const f of this.def.statusFrames) {
      const tick = (): void => {
        if (this.resolved && !this.inBootloader) {
          this.send(encodeStatus(this.address, { index: f.index, data: encodeStatusFrame(f, this.signalValues) }));
        }
        this.statusTimers.push(this.later(f.defaultPeriodMs, tick));
      };
      this.statusTimers.push(this.later(f.defaultPeriodMs, tick));
    }
  }

  private enumRsp(): TxFrame {
    return encodeEnumRsp(this.address, {
      uid48: this.uid48,
      num: this.num,
      conflict: this.conflict,
      bootloader: this.inBootloader,
      model: this.def.model,
    });
  }

  receive(frame: CanFrame): void {
    if (!this.powered || !isCyCanId(frame.id)) return;
    const id = frame.id;
    const cls = idClass(id);
    const index = idIndex(id);
    const d = frame.data;
    // Conflict detection: our address, different uid16.
    if (cls === Cls.SYS_RSP && index === SysRsp.HEARTBEAT && idDevType(id) === this.devType && idNum(id) === this.num) {
      const hb = decodeHeartbeat(d);
      if (hb && hb.uid16 !== this.uid16 && this.num !== NUM_UNASSIGNED) {
        this.conflict = true;
        this.disarm();
      }
      return;
    }
    // Recovery window: only the broadcast recovery beacon is looked at (PROTOCOL §9.0).
    if (this.recoveryUntil >= 0) {
      if (this.sched.now() <= this.recoveryUntil && cls === Cls.SYS_REQ && index === SysReq.COMMAND && idDevType(id) === 0 && idNum(id) === 0) {
        const r = decodeCommand(d);
        if (r?.cmd === Command.ENTER_BOOTLOADER && r.arg === RECOVERY_STAY_MAGIC) {
          this.recoveryUntil = -1;
          this.state = DeviceState.BOOTLOADER;
          this.startHeartbeat();
        }
      }
      return;
    }
    if (!acceptsFrame(id, this.devType, this.num)) {
      // ASSIGN_ID / IDENTIFY(UID) / ENUM_REQ are broadcasts; acceptsFrame covers them.
      return;
    }
    this.received.push(frame);
    if (this.mute.has(cls)) return;
    if (this.inBootloader) {
      // Bootloader: discovery, IDENTIFY, INFO 0..2, REBOOT and FW only (PROTOCOL §9).
      if (cls === Cls.SYS_REQ) this.onBootloaderSys(index, d, idNum(id) === 0);
      else if (cls === Cls.FW_REQ && this.resolved) this.onFw(index, d);
      return;
    }
    if (cls === Cls.SYS_REQ) {
      this.onSys(index, d, idNum(id) === 0 || idDevType(id) === 0);
      return;
    }
    if (!this.resolved) return;
    switch (cls) {
      case Cls.PARAM_REQ:
        this.onParam(index, d);
        return;
      case Cls.STREAM_REQ:
        this.onStream(index, d);
        return;
      case Cls.CTRL:
        this.onCtrl(frame);
        return;
      case Cls.FW_REQ:
        this.send(encodeFwAck(this.address, { status: FwStatus.WRONG_STATE, window: 0, nextOffset: 0 }));
        return;
    }
  }

  private onBootloaderSys(index: number, d: Uint8Array, broadcast: boolean): void {
    if (index === SysReq.ENUM_REQ || index === SysReq.ASSIGN_ID || index === SysReq.IDENTIFY) {
      this.onSys(index, d, broadcast);
      return;
    }
    if (!this.resolved) return;
    if (index === SysReq.INFO_REQ) {
      const r = decodeInfoReq(d);
      if (r && r.page <= InfoPage.UID_HI) this.send(this.infoFrame(r.page));
      return;
    }
    if (index === SysReq.COMMAND && !broadcast) {
      const r = decodeCommand(d);
      if (r?.cmd === Command.REBOOT) {
        this.reply(Command.REBOOT, CommandStatus.OK);
        this.later(1, () => this.leaveBootloader());
      }
    }
  }

  /** Bootloader starts the installed application (it kept the image when nothing was erased). */
  private leaveBootloader(): void {
    this.stopTimers();
    this.fwPhase = 'idle';
    this.fwBuf = null;
    this.resetRam();
    this.state = DeviceState.BOOT;
    this.startApp();
  }

  private onSys(index: number, d: Uint8Array, broadcast = false): void {
    switch (index) {
      case SysReq.ENUM_REQ: {
        const r = decodeEnumReq(d);
        if (!r || (r.filter === 1 && this.resolved)) return;
        this.later(this.enumDelay, () => this.send(this.enumRsp()));
        return;
      }
      case SysReq.ASSIGN_ID: {
        const r = decodeAssignId(d);
        if (!r || r.uid48 !== this.uid48) return;
        if (r.newNum !== this.num) {
          // A new address: whatever drove the old one must not drive this board (PROTOCOL §3.3).
          this.disarm();
          this.cancel(this.streamTimer);
          this.streamTimer = undefined;
        }
        this.num = r.newNum;
        this.conflict = false;
        if (r.persist) this.persistedNum = r.newNum;
        this.later(this.enumDelay, () => this.send(this.enumRsp()));
        return;
      }
      case SysReq.IDENTIFY: {
        const r = decodeIdentify(d);
        if (!r) return;
        if (r.kind === 'identifyUid') {
          if (r.uid48 === this.uid48) this.identifySeconds = r.seconds;
        } else if (this.resolved) {
          this.identifySeconds = r.seconds;
        }
        return;
      }
      case SysReq.ESTOP:
        if (d[0] === ESTOP_MAGIC_0 && d[1] === ESTOP_MAGIC_1 && this.resolved) {
          this.estopFrames++;
          this.state = DeviceState.ESTOP;
          this.disarm();
          this.faults.active |= 1 << FaultBit.ESTOP;
        }
        return;
    }
    if (!this.resolved) return;
    // Broadcast commands: only the (bootloader) recovery beacon exists; applications ignore it.
    if (broadcast && index === SysReq.COMMAND) return;
    switch (index) {
      case SysReq.INFO_REQ: {
        const r = decodeInfoReq(d);
        if (r) this.send(this.infoFrame(r.page));
        return;
      }
      case SysReq.NAME_SET: {
        const r = decodeNameSet(d);
        if (!r || r.page > 2) return;
        this.name.set(r.bytes, 7 * r.page);
        this.unsaved = true;
        this.send(this.infoFrame(InfoPage.NAME_0 + r.page));
        return;
      }
      case SysReq.COMMAND: {
        const r = decodeCommand(d);
        if (r) this.onCommand(r.cmd, r.arg);
        return;
      }
      case SysReq.FAULT_REQ:
        this.send(encodeFaultRsp(this.address, this.faults));
        return;
    }
  }

  private infoFrame(page: number): TxFrame {
    const a = this.address;
    switch (page) {
      case InfoPage.DEVICE:
        return encodeInfoRsp(a, {
          section: 'device',
          page: 0,
          model: this.def.model,
          hwRev: this.hwRev,
          protoMajor: 1,
          protoMinor: 0,
          catalogRev: this.catalogRev,
          bootloaderVer: 1,
        });
      case InfoPage.UID_LO:
      case InfoPage.UID_HI: {
        const [p1, p2] = uid96ToInfoPages(this.uid96);
        return encodeInfoRsp(a, { section: 'bytes', page, bytes: page === 1 ? p1 : p2 });
      }
      case InfoPage.BUILD:
        return encodeInfoRsp(a, { section: 'build', page: 3, gitHash: 0xdeadbeef, buildDay: 300, dirty: false });
      default:
        if (page >= 4 && page <= 6) {
          return encodeInfoRsp(a, { section: 'bytes', page, bytes: this.name.slice(7 * (page - 4), 7 * (page - 4) + 7) });
        }
        return encodeInfoRsp(a, { section: 'bytes', page, bytes: new Uint8Array(7) });
    }
  }

  get nameText(): string {
    return decodeName(this.name);
  }

  private reply(cmd: number, status: number, result = 0): void {
    if (cmd === Command.ENTER_BOOTLOADER && status === CommandStatus.OK && this.dropEnterBootloaderRsp > 0) {
      this.dropEnterBootloaderRsp--;
      return;
    }
    this.send(encodeCommandRsp(this.address, { cmd, status, result }));
  }

  /** ESTOP frames received (the host repeats them). */
  estopFrames = 0;

  private onCommand(cmd: number, arg: number): void {
    // PROTOCOL §4.5: refused while driven; REBOOT/ENTER_BOOTLOADER also while in ESTOP.
    const lockedWhileDriven: number[] = [
      Command.REBOOT,
      Command.ENTER_BOOTLOADER,
      Command.SAVE_PARAMS,
      Command.LOAD_DEFAULTS,
      Command.LOAD_SAVED,
    ];
    if (this.enabled && lockedWhileDriven.includes(cmd)) {
      this.reply(cmd, CommandStatus.DENIED);
      return;
    }
    if (this.state === DeviceState.ESTOP && (cmd === Command.REBOOT || cmd === Command.ENTER_BOOTLOADER)) {
      this.reply(cmd, CommandStatus.DENIED);
      return;
    }
    if (cmd === Command.ENTER_BOOTLOADER) {
      if (this.ignoreEnterBootloader > 0) {
        this.ignoreEnterBootloader--;
        return;
      }
      if (arg >>> 0 !== (ENTER_BOOTLOADER_INTENT | this.uid16) >>> 0) {
        this.reply(cmd, CommandStatus.INVALID_ARG);
        return;
      }
    }
    const script = this.commandScripts.get(cmd);
    if (script) {
      if (script.delayMs !== undefined) {
        this.reply(cmd, CommandStatus.IN_PROGRESS);
        this.later(script.delayMs, () => this.reply(cmd, script.status, script.result ?? 0));
      } else {
        this.reply(cmd, script.status, script.result ?? 0);
      }
      return;
    }
    switch (cmd) {
      case Command.REBOOT:
        this.reply(cmd, CommandStatus.OK);
        this.reboot(false);
        return;
      case Command.ENTER_BOOTLOADER:
        this.reply(cmd, CommandStatus.OK);
        this.reboot(true);
        return;
      case Command.SAVE_PARAMS:
        this.saved = new Map(this.params);
        this.unsaved = false;
        this.reply(cmd, CommandStatus.OK);
        return;
      case Command.LOAD_DEFAULTS:
        for (const p of this.def.params) this.params.set(p.pid, p.default);
        this.unsaved = true;
        this.reply(cmd, CommandStatus.OK);
        return;
      case Command.LOAD_SAVED:
        this.params = new Map(this.saved);
        this.unsaved = false;
        this.reply(cmd, CommandStatus.OK);
        return;
      case Command.CLEAR_FAULTS:
        this.faults.sticky = 0;
        this.reply(cmd, CommandStatus.OK);
        return;
      case Command.SELF_TEST:
        this.reply(cmd, CommandStatus.IN_PROGRESS);
        this.later(300, () => this.reply(cmd, CommandStatus.OK, this.selfTestMask));
        return;
      case Command.CLEAR_ESTOP:
        this.state = DeviceState.IDLE;
        this.faults.active &= ~(1 << FaultBit.ESTOP);
        this.reply(cmd, CommandStatus.OK);
        return;
    }
    const action = actionByCmd(this.def, cmd);
    if (!action) {
      this.reply(cmd, CommandStatus.UNSUPPORTED);
      return;
    }
    void arg;
    if (action.longRunning) {
      this.reply(cmd, CommandStatus.IN_PROGRESS);
      this.later(200, () => this.reply(cmd, CommandStatus.OK, 1));
    } else {
      this.reply(cmd, CommandStatus.OK);
    }
  }

  private reboot(toBootloader: boolean): void {
    this.later(1, () => {
      this.stopTimers();
      this.resetRam();
      this.state = toBootloader ? DeviceState.BOOTLOADER : DeviceState.BOOT;
      this.later(200, () => {
        if (toBootloader) this.startHeartbeat();
        else this.startApp();
      });
    });
  }

  private onParam(index: number, d: Uint8Array): void {
    if (index === ParamReq.GET) {
      const r = decodeParamGet(d);
      if (!r) return;
      if (this.dropParamGets > 0) {
        this.dropParamGets--;
        return;
      }
      const p = paramById(this.def, r.pid);
      if (!p) {
        this.send(encodeParamValue(this.address, { pid: r.pid, ptype: 0, status: ParamStatus.UNKNOWN_PARAM, value: 0 }));
        return;
      }
      this.send(encodeParamValue(this.address, { pid: p.pid, ptype: p.ptype, status: ParamStatus.OK, value: this.params.get(p.pid) ?? 0 }));
      return;
    }
    if (index !== ParamReq.SET) return;
    const r = decodeParamSet(d);
    if (!r) return;
    const p = paramById(this.def, r.pid);
    if (!p) {
      this.send(encodeParamValue(this.address, { pid: r.pid, ptype: r.ptype, status: ParamStatus.UNKNOWN_PARAM, value: 0 }));
      return;
    }
    const cur = this.params.get(p.pid) ?? 0;
    let status: number = ParamStatus.OK;
    if (r.ptype !== p.ptype) status = ParamStatus.TYPE_MISMATCH;
    else if (p.readOnly) status = ParamStatus.READ_ONLY;
    else if (p.lockedWhileEnabled && this.enabled) status = ParamStatus.DENIED_WHILE_ENABLED;
    else if (checkParamValue(p, r.value) !== 'ok') status = ParamStatus.OUT_OF_RANGE;
    if (status === ParamStatus.OK) {
      this.params.set(p.pid, quantizeParamValue(p, r.value));
      this.unsaved = true;
    }
    this.send(encodeParamValue(this.address, { pid: p.pid, ptype: p.ptype, status, value: this.params.get(p.pid) ?? cur }));
  }

  /**
   * PROTOCOL §7: broadcast CTRL is ignored; only valid frames feed the timeout; a target is
   * only taken after a neutral command since the last forced neutral.
   */
  private onCtrl(frame: CanFrame): void {
    const entry = { t: this.sched.now(), frame, accepted: false };
    this.ctrl.push(entry);
    if (idNum(frame.id) === 0 || idDevType(frame.id) === 0) return;
    if (this.state === DeviceState.ESTOP || this.state === DeviceState.FAULT) return;
    const c = this.def.controls.find((x) => x.index === idIndex(frame.id));
    if (!c) return;
    let neutral: boolean;
    let target: { mode: number; value: number } | null = null;
    if (c.format === 'set') {
      const set = decodeCtrlSet(frame.data);
      if (!set || frame.data.length !== 8) return;
      neutral = set.mode === 0 && set.value === 0;
      target = { mode: set.mode, value: set.value };
    } else if (c.format === 'servo4') {
      const m = decodeCtrlServo(frame.data, c.index);
      if (!m) return;
      neutral = m.pulsesUs.every((p) => p === 0);
    } else {
      entry.accepted = true;
      return;
    }
    if (neutral) {
      this.armed = true;
      this.enabled = false;
      this.target = null;
    } else {
      if (!this.armed) return;
      this.enabled = true;
      this.target = target;
    }
    entry.accepted = true;
    this.feedCtrlTimeout();
  }

  private feedCtrlTimeout(): void {
    this.cancel(this.ctrlTimer);
    const timeout = this.param('ctrl.timeout_ms') ?? 200;
    this.ctrlTimer = this.later(timeout, () => {
      this.ctrlTimer = undefined;
      if (!this.enabled) return;
      this.disarm();
      this.faults.warn |= 1 << FaultBit.CTRL_TIMEOUT;
    });
  }

  // Streaming --------------------------------------------------------------------------

  private onStream(index: number, d: Uint8Array): void {
    if (index === StreamReq.CONFIG) {
      const r = decodeStreamConfig(d);
      if (!r || r.slot > 14) return;
      if (r.sid === 0xffff) {
        this.slots.length = Math.min(this.slots.length, r.slot);
      } else if (signalBySid(this.def, r.sid)) {
        this.slots[r.slot] = r.sid;
      }
      return;
    }
    if (index === StreamReq.START) {
      const r = decodeStreamStart(d);
      if (!r) return;
      const minUs = this.def.stream.minPeriodUs;
      const periodMs = Math.max(r.period100us * 100, minUs) / 1000;
      this.streamDeadline = this.sched.now() + 2000;
      if (this.streamTimer === undefined || periodMs !== this.streamPeriod) {
        this.cancel(this.streamTimer);
        this.streamPeriod = periodMs;
        this.streamTimer = this.later(periodMs, () => this.sample());
      }
      return;
    }
    if (index === StreamReq.STOP) {
      this.cancel(this.streamTimer);
      this.streamTimer = undefined;
    }
  }

  get streaming(): boolean {
    return this.streamTimer !== undefined;
  }

  get streamSlots(): readonly number[] {
    return this.slots;
  }

  private sample(): void {
    this.streamTimer = undefined;
    if (this.sched.now() > this.streamDeadline) return;
    const seq = this.seq;
    this.seq = (this.seq + 1) & 0xff;
    const n = this.slots.length;
    const t100us = Math.round(this.sched.now() * 10) & 0xffff;
    if (n > 0 && !this.streamSkip(seq)) {
      const values = this.slots.map((sid) => this.streamValue(sid, seq));
      if (this.fd) {
        this.send(encodeStreamData(this.address, { seq, firstSlot: 0, t100us, values }));
      } else {
        values.forEach((v, slot) => this.send(encodeStreamData(this.address, { seq, firstSlot: slot, t100us, values: [v] })));
      }
    }
    this.streamTimer = this.later(this.streamPeriod, () => this.sample());
  }

  // Firmware ---------------------------------------------------------------------------

  private ack(status: number, nextOffset = this.fwExpected): void {
    this.send(encodeFwAck(this.address, { status, window: this.fwWindow, nextOffset }));
  }

  /**
   * PROTOCOL §9: BEGIN is answered OK at once without erasing; the header (first 64 bytes) is
   * checked in RAM, then the board erases (BUSY) and answers OK with the offset to continue
   * from. After END it verifies (BUSY) and starts the application.
   */
  private onFw(index: number, d: Uint8Array): void {
    if (this.fwPhase === 'erase' || this.fwPhase === 'verify') {
      this.ack(FwStatus.BUSY);
      return;
    }
    if (index === FwReq.BEGIN) {
      const r = decodeFwBegin(d);
      if (!r) return;
      this.fwSize = r.size;
      this.fwCrc = r.crc32;
      this.fwBuf = new Uint8Array(r.size + 64);
      this.fwExpected = 0;
      this.fwCount = 0;
      this.fwPhase = 'header';
      this.ack(FwStatus.OK, 0);
      return;
    }
    if (!this.fwBuf || this.fwPhase === 'idle') {
      this.ack(FwStatus.WRONG_STATE, 0);
      return;
    }
    if (index === FwReq.DATA) {
      const r = decodeFwData(d);
      if (!r) return;
      if (this.fwDropOffsetOnce === r.offset) {
        this.fwDropOffsetOnce = null;
        return;
      }
      if (r.offset !== this.fwExpected) {
        this.fwCount = 0;
        this.ack(FwStatus.BAD_OFFSET);
        return;
      }
      const n = Math.min(r.bytes.length, this.fwSize - r.offset);
      this.fwBuf.set(r.bytes.subarray(0, n), r.offset);
      if (this.fwCorruptOffset !== null && this.fwCorruptOffset >= r.offset && this.fwCorruptOffset < r.offset + n) {
        this.fwBuf[this.fwCorruptOffset] = (this.fwBuf[this.fwCorruptOffset] ?? 0) ^ 0xff;
      }
      this.fwExpected += n;
      if (this.fwPhase === 'header' && this.fwExpected >= Math.min(CYFW_HEADER_SIZE, this.fwSize)) {
        const h = decodeCyfwHeader(this.fwBuf.subarray(0, CYFW_HEADER_SIZE));
        if (!h || h.model !== this.def.model || this.hwRev < h.hwRevMin || this.hwRev > h.hwRevMax) {
          // Nothing erased: the installed application stays.
          this.fwPhase = 'idle';
          this.fwBuf = null;
          this.ack(FwStatus.BAD_IMAGE, 0);
          return;
        }
        this.fwPhase = 'erase';
        this.fw = [0, 0, 0];
        this.ack(FwStatus.BUSY);
        this.later(this.fwBeginBusyMs, () => {
          this.fwPhase = 'data';
          this.fwCount = 0;
          this.ack(FwStatus.OK);
        });
        return;
      }
      const busy = this.fwBusyAt;
      if (busy && this.fwExpected >= busy.offset) {
        this.fwBusyAt = null;
        this.fwPhase = 'erase';
        this.ack(FwStatus.BUSY);
        this.later(busy.ms, () => {
          this.fwPhase = 'data';
          this.fwCount = 0;
          this.ack(FwStatus.OK);
        });
        return;
      }
      if (++this.fwCount >= this.fwWindow) {
        this.fwCount = 0;
        this.ack(FwStatus.OK);
      }
      return;
    }
    if (index === FwReq.END) {
      this.fwCount = 0;
      if (this.fwExpected < this.fwSize) {
        this.ack(FwStatus.BAD_OFFSET);
        return;
      }
      const image = this.fwBuf.subarray(0, this.fwSize);
      if (crc32(image) !== this.fwCrc) {
        this.fwPhase = 'idle';
        this.ack(FwStatus.BAD_CRC);
        return;
      }
      const h = decodeCyfwHeader(image);
      if (this.fwDropEndAcks > 0) this.fwDropEndAcks--;
      else this.ack(FwStatus.OK);
      this.fwPhase = 'verify';
      this.fwBuf = null;
      this.later(50, () => {
        this.stopTimers();
        this.fwPhase = 'idle';
        this.fw = this.fwVersionAfterUpdate ?? (h ? [h.fwMajor, h.fwMinor, h.fwPatch] : this.fw);
        this.resetRam();
        this.startApp();
      });
    }
  }
}
