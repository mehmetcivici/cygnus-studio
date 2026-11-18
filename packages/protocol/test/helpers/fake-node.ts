import { actionByCmd, getModel, paramById, signalBySid } from '../../src/catalog/catalog';
import type { ModelDef } from '../../src/catalog/schema';
import { encodeStatusFrame } from '../../src/catalog/status';
import { checkParamValue, quantizeParamValue } from '../../src/catalog/values';
import {
  Cls,
  Command,
  CommandStatus,
  DeviceState,
  FW_WINDOW_DEFAULT,
  FwReq,
  FwStatus,
  InfoPage,
  NUM_UNASSIGNED,
  ParamReq,
  ParamStatus,
  StreamReq,
  SysReq,
  SysRsp,
} from '../../src/core/constants';
import { crc32 } from '../../src/core/crc32';
import { decodeCyfwHeader } from '../../src/core/cyfw';
import { deriveUid } from '../../src/core/fnv';
import type { Address, CanFrame, TxFrame } from '../../src/core/frame';
import { acceptsFrame, idClass, idDevType, idIndex, idNum, isCyCanId } from '../../src/core/id';
import {
  decodeAssignId,
  decodeCommand,
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
 * discovery with UID-derived delays, conflict detection, INFO, params, commands, faults,
 * STATUS, streaming (FD and classic) and a bootloader with windowed firmware transfer.
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
  ctrl: Array<{ t: number; frame: CanFrame }> = [];
  powered = true;

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
  fwBeginBusyMs = 30;
  fwWindow = FW_WINDOW_DEFAULT;
  /** Version the board reports after flashing; null = take it from the image header. */
  fwVersionAfterUpdate: [number, number, number] | null = null;

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
  private fwReady = false;

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

  powerOn(): void {
    this.powered = true;
    this.state = this.inBootloader ? DeviceState.BOOTLOADER : DeviceState.IDLE;
    this.slots = [];
    this.startHeartbeat();
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
        this.enabled = false;
      }
      return;
    }
    if (!acceptsFrame(id, this.devType, this.num)) {
      // ASSIGN_ID / IDENTIFY(UID) / ENUM_REQ are broadcasts; acceptsFrame covers them.
      return;
    }
    this.received.push(frame);
    if (this.mute.has(cls)) return;
    if (cls === Cls.SYS_REQ) {
      this.onSys(index, d);
      return;
    }
    if (!this.resolved) return;
    if (this.inBootloader) {
      if (cls === Cls.FW_REQ) this.onFw(index, d);
      return;
    }
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

  private onSys(index: number, d: Uint8Array): void {
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
        if (d[0] === 0xe5 && d[1] === 0x70 && this.resolved) {
          this.state = DeviceState.ESTOP;
          this.enabled = false;
          this.faults.active |= 1 << 9;
        }
        return;
    }
    if (!this.resolved) return;
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
    this.send(encodeCommandRsp(this.address, { cmd, status, result }));
  }

  private onCommand(cmd: number, arg: number): void {
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
        this.faults.active &= ~(1 << 9);
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
      this.params = new Map(this.saved);
      this.unsaved = false;
      this.enabled = false;
      this.slots = [];
      this.state = toBootloader ? DeviceState.BOOTLOADER : DeviceState.BOOT;
      this.later(200, () => {
        if (!toBootloader) this.state = DeviceState.IDLE;
        this.startHeartbeat();
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

  private onCtrl(frame: CanFrame): void {
    if (this.state === DeviceState.ESTOP) return;
    this.ctrl.push({ t: this.sched.now(), frame });
    const set = decodeCtrlSet(frame.data);
    const c = this.def.controls.find((x) => x.index === idIndex(frame.id));
    if (c?.format === 'set' && set) this.enabled = set.mode !== 0;
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

  private onFw(index: number, d: Uint8Array): void {
    if (index === FwReq.BEGIN) {
      const r = decodeFwBegin(d);
      if (!r) return;
      this.fwSize = r.size;
      this.fwCrc = r.crc32;
      this.fwBuf = new Uint8Array(r.size + 64);
      this.fwExpected = 0;
      this.fwCount = 0;
      this.fwReady = false;
      this.ack(FwStatus.BUSY, 0);
      this.later(this.fwBeginBusyMs, () => {
        this.fwReady = true;
        this.ack(FwStatus.OK, 0);
      });
      return;
    }
    if (!this.fwBuf || !this.fwReady) {
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
      if (++this.fwCount >= this.fwWindow) {
        this.fwCount = 0;
        this.ack(FwStatus.OK);
      }
      return;
    }
    if (index === FwReq.END) {
      if (this.fwExpected < this.fwSize) {
        this.ack(FwStatus.BAD_OFFSET);
        return;
      }
      const image = this.fwBuf.subarray(0, this.fwSize);
      if (crc32(image) !== this.fwCrc) {
        this.ack(FwStatus.BAD_CRC);
        return;
      }
      const h = decodeCyfwHeader(image);
      this.ack(FwStatus.OK);
      this.fwBuf = null;
      this.later(50, () => {
        this.stopTimers();
        this.fw = this.fwVersionAfterUpdate ?? (h ? [h.fwMajor, h.fwMinor, h.fwPatch] : this.fw);
        this.state = DeviceState.IDLE;
        this.startHeartbeat();
      });
    }
  }
}
