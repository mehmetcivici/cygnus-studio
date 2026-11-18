import {
  Cls,
  Command,
  CommandStatus,
  CommonPid,
  DataBitrate,
  DeviceState,
  EnumFilter,
  FaultBit,
  FwReq,
  FwStatus,
  FW_WINDOW_DEFAULT,
  InfoPage,
  MFR,
  NAME_BYTES,
  NUM_MAX,
  NUM_MIN,
  NUM_UNASSIGNED,
  PROTO_MAJOR,
  PROTO_MINOR,
  ParamReq,
  STREAM_SID_CLEAR,
  STREAM_SLOTS,
  StreamReq,
  SysReq,
  SysRsp,
  Timing,
  acceptsFrame,
  crc32,
  decodeAssignId,
  decodeCommand,
  decodeIdentify,
  decodeName,
  deriveUid,
  encodeCommandRsp,
  encodeEnumRsp,
  encodeFaultRsp,
  encodeFwAck,
  encodeHeartbeat,
  encodeInfoRsp,
  encodeParamValue,
  fdRoundUp,
  getModel,
  idClass,
  idDevType,
  idIndex,
  idMfr,
  idNum,
  readF32,
  readU16,
  readU24,
  readU32,
  readParamValue,
  statusPeriodPid,
  uid96ToInfoPages,
  validateCyfw,
  writeF32,
  writeU16,
  encodeName,
  type ModelDef,
  type TxFrame,
} from '@cygnus/protocol';
import type { BusEndpoint, BusFrame, SimBus } from './bus';
import { ParamTable } from './params';
import type { Prng } from './prng';
import { CompiledStatusFrame } from './status-codec';
import type { PowerFeed, World } from './world';

/** What a node sees of the simulation it lives in. */
export interface SimContext {
  readonly timeMs: number;
  readonly bus: SimBus;
  readonly world: World;
}

/** Fault/condition injections offered by the simulator panel. Each board supports a subset. */
export type InjectionKind =
  | 'overtemp'
  | 'motorDisconnected'
  | 'hallLost'
  | 'magnetMissing'
  | 'magnetWeak'
  | 'magnetStrong'
  | 'leak'
  | 'jam'
  | 'fuseBlown'
  | 'auxOvercurrent'
  | 'railOvercurrent'
  | 'outputOvercurrent'
  | 'paramCrc'
  | 'hardware'
  | 'selfTestFail'
  | 'flashError';

export const COMMON_INJECTIONS: readonly InjectionKind[] = ['paramCrc', 'hardware', 'selfTestFail', 'flashError'];

export interface FirmwareVersion {
  major: number;
  minor: number;
  patch: number;
}

export interface SimNodeOptions {
  /** Stable simulator id (shown in the panel); defaults to `<modelKey>-<n>`. */
  id?: string;
  /** 96-bit MCU UID; random (from the simulation seed) when omitted. */
  uid96?: Uint8Array;
  /** Persisted device number; default 63 (factory fresh). */
  num?: number;
  name?: string;
  fw?: FirmwareVersion;
  hwRev?: number;
  /** Persisted parameter values (catalog key → value). */
  params?: Readonly<Record<string, number>>;
  /** Power feed; the simulation defaults it to the battery. */
  feed?: PowerFeed;
}

export const NodeMode = { OFF: 0, BOOT: 1, APP: 2, BOOTLOADER: 3 } as const;
export type NodeMode = (typeof NodeMode)[keyof typeof NodeMode];

export interface NodeSnapshot {
  id: string;
  model: number;
  modelKey: string;
  devType: number;
  num: number;
  uid48: number;
  uid48Hex: string;
  name: string;
  state: number;
  mode: 'off' | 'boot' | 'app' | 'bootloader';
  powered: boolean;
  connected: boolean;
  conflict: boolean;
  identify: boolean;
  enabled: boolean;
  unsaved: boolean;
  faults: { active: number; sticky: number; warn: number };
  fw: FirmwareVersion;
  supplyV: number;
  supplyA: number;
  streaming: boolean;
  signals: Record<string, number>;
  injections: InjectionKind[];
  activeInjections: InjectionKind[];
}

const BITRATE_BPS = [0, 2_000_000, 5_000_000, 8_000_000] as const;
const BOOT_MS = 250;
const BOOTLOADER_BOOT_MS = 120;
const SELF_TEST_MS = 300;
const FW_MAX_SIZE = 1 << 20;
const FW_VERIFY_MS = 40;
/** Remote encoder status older than this counts as lost. */
export const PEER_TIMEOUT_MS = 100;

let nodeCounter = 0;

/**
 * CyCAN firmware reference implementation. Subclasses add the board's physics and model
 * behaviour through the protected hooks; everything protocol-level lives here.
 */
export abstract class SimNode implements BusEndpoint {
  readonly def: ModelDef;
  readonly id: string;
  readonly uid96: Uint8Array;
  readonly uid48: number;
  readonly uid16: number;
  readonly hash10: number;
  readonly enumDelay: number;
  readonly hwRev: number;
  readonly params: ParamTable;
  /** Signal values in catalog order. */
  readonly sig: Float64Array;
  readonly actuator: boolean;
  feed: PowerFeed | null;
  protected ctx!: SimContext;
  protected rng!: Prng;

  // Persisted identity and firmware.
  private flashNum: number;
  private readonly flashName = new Uint8Array(NAME_BYTES);
  private appFw: FirmwareVersion;
  private appValid = true;
  private gitHash: number;
  private buildDay: number;
  private flashCorrupt = false;
  private flashWriteFails = false;
  private selfTestMask = 0;

  // Runtime state.
  mode: NodeMode = NodeMode.OFF;
  num: number;
  readonly name = new Uint8Array(NAME_BYTES);
  conflict = false;
  private bootDoneAt = 0;
  private bootIntoLoader = false;
  private identifyUntil = -1;
  private estop = false;
  protected faultActive = 0;
  protected faultSticky = 0;
  protected faultWarn = 0;
  private hwFault = false;
  supplyV = 0;
  private dataBitrate = 0;
  private hbNext = 0;
  private readonly hbPhase: number;
  private enumAt = -1;
  private enumRetried = false;
  private longCmd = -1;
  private selfTestAt = -1;
  private ctrlSeen = false;
  private lastCtrlMs = 0;
  private canErr = false;

  // Status frames.
  private readonly statusFrames: CompiledStatusFrame[];
  private readonly statusPeriodIdx: number[];
  private readonly statusNext: number[];

  // Stream.
  private readonly streamSig = new Int32Array(STREAM_SLOTS).fill(-1);
  private streamCount = 0;
  private streamPeriod = 0;
  private streamAcc = 0;
  private streamOn = false;
  private streamLastStart = 0;
  private streamSeq = 0;
  /**
   * Stream sampling step in 100 µs units. 10 = sampled once per ms in `tick`; boards with a
   * 500 µs minimum set 5 and call `streamAdvance(5, 5)` from their fast loop as well.
   */
  protected streamGranularity = 10;

  // Firmware update (bootloader).
  private fwPhase: 'idle' | 'erasing' | 'receiving' | 'verifying' = 'idle';
  private fwBuf: Uint8Array | null = null;
  private fwSize = 0;
  private fwCrc = 0;
  private fwNext = 0;
  private fwSinceAck = 0;
  private fwPhaseDoneAt = 0;
  private fwBadOffsetSent = false;

  protected readonly tx = new Uint8Array(64);
  private readonly pCtrlTimeout: number;
  private readonly pDataBitrate: number;
  private readonly pTermination: number;

  constructor(model: number, o: SimNodeOptions = {}) {
    const def = getModel(model);
    if (!def) throw new Error(`unknown model ${model}`);
    this.def = def;
    this.id = o.id ?? `${def.key}-${++nodeCounter}`;
    this.uid96 = o.uid96 ?? placeholderUid(this.id);
    const u = deriveUid(this.uid96);
    this.uid48 = u.uid48;
    this.uid16 = u.uid16;
    this.hash10 = u.hash10;
    this.enumDelay = u.enumDelayMs;
    this.hbPhase = this.uid48 % (Timing.HEARTBEAT_PHASE_MAX_MS + 1);
    this.hwRev = o.hwRev ?? 1;
    this.params = new ParamTable(def, o.params);
    this.sig = new Float64Array(def.signals.length);
    this.actuator = this.params.has('ctrl.timeout_ms');
    this.flashNum = o.num ?? NUM_UNASSIGNED;
    this.num = this.flashNum;
    if (o.name) this.flashName.set(encodeName(o.name));
    this.appFw = o.fw ?? { major: 1, minor: 0, patch: 0 };
    this.gitHash = (this.uid48 * 2654435761) >>> 0;
    this.buildDay = 300;
    this.feed = o.feed ?? null;
    this.statusFrames = def.statusFrames.map((f) => new CompiledStatusFrame(def, f));
    this.statusPeriodIdx = def.statusFrames.map((f) => this.params.indexOfPid(statusPeriodPid(f.index)));
    this.statusNext = def.statusFrames.map(() => 0);
    this.pCtrlTimeout = this.params.indexOfPid(CommonPid.CTRL_TIMEOUT_MS);
    this.pDataBitrate = this.params.indexOfPid(CommonPid.CAN_DATA_BITRATE);
    this.pTermination = this.params.indexOfPid(CommonPid.CAN_TERMINATION);
  }

  /** Called by the simulation when the node is added. */
  attach(ctx: SimContext, rng: Prng): void {
    this.ctx = ctx;
    this.rng = rng;
    this.onAttach();
  }

  // ---- hooks for boards ------------------------------------------------------------------

  protected onAttach(): void {}
  /** RAM was (re)loaded and the application starts. */
  protected onAppStart(): void {}
  /** Power lost or reboot: drop runtime state, outputs off. */
  protected onAppStop(): void {}
  /** 1 kHz application step (sensors, control loops), runs whenever the app runs. */
  protected appTick(): void {}
  /** CTRL frame for this board; return true if it was a valid command. */
  protected onCtrl(_index: number, _data: Uint8Array, _len: number): boolean {
    return false;
  }
  /** Actuator outputs to neutral (ESTOP, timeout, unassigned). */
  protected neutral(): void {}
  /** Frames other boards send (STATUS, HEARTBEAT…), for boards that listen to peers. */
  protected onPeerFrame(_f: BusFrame): void {}
  protected readonly listensToPeers: boolean = false;
  /** Model command (≥ 0x40); long actions answer IN_PROGRESS and later call completeCommand. */
  protected action(_cmd: number, _arg: number): { status: number; result: number } {
    return { status: CommandStatus.UNSUPPORTED, result: 0 };
  }
  /** SELF_TEST result bits from the board's own checks. */
  protected selfTest(): number {
    return 0;
  }
  /** CLEAR_FAULTS: release latched model faults. */
  protected onClearFaults(): void {}
  /** Whether the board is driving an actuator right now (ENABLED flag, lockedWhileEnabled). */
  isEnabled(): boolean {
    return false;
  }
  /** Current drawn from the supply feed, A. */
  supplyCurrent(): number {
    return this.mode === NodeMode.OFF ? 0 : 0.04;
  }
  /** Lowest supply voltage the board's MCU runs at. */
  protected readonly minSupplyV: number = 4.5;
  /** Injections this board supports (beyond the common ones). */
  supportedInjections(): InjectionKind[] {
    return [];
  }
  protected injectModel(_kind: InjectionKind, _on: boolean, _arg: number): boolean {
    return false;
  }
  protected activeModelInjections(): InjectionKind[] {
    return [];
  }

  // ---- helpers for boards ----------------------------------------------------------------

  protected sigIndex(key: string): number {
    const i = this.def.signals.findIndex((s) => s.key === key);
    if (i < 0) throw new Error(`${this.def.key}: unknown signal ${key}`);
    return i;
  }

  protected p(i: number): number {
    return this.params.ram[i] ?? 0;
  }

  protected setFault(bit: number, on: boolean): void {
    const m = 1 << bit;
    if (on) {
      this.faultActive |= m;
      this.faultSticky |= m;
    } else this.faultActive &= ~m;
  }

  protected setWarn(bit: number, on: boolean): void {
    const m = 1 << bit;
    if (on) {
      this.faultWarn |= m;
      this.faultSticky |= m;
    } else this.faultWarn &= ~m;
  }

  protected hasFault(bit: number): boolean {
    return (this.faultActive & (1 << bit)) !== 0;
  }

  get now(): number {
    return this.ctx.timeMs;
  }

  get assigned(): boolean {
    return this.num >= NUM_MIN && this.num <= NUM_MAX && !this.conflict;
  }

  get running(): boolean {
    return this.mode === NodeMode.APP;
  }

  /** ESTOP latched, CTRL timed out, unassigned, or not running: actuators must be neutral. */
  protected get commandable(): boolean {
    return this.mode === NodeMode.APP && this.assigned && !this.estop && this.ctrlSeen;
  }

  get estopped(): boolean {
    return this.estop;
  }

  get fdMode(): boolean {
    return this.dataBitrate !== DataBitrate.CLASSIC;
  }

  get firmware(): FirmwareVersion {
    return { ...this.appFw };
  }

  get terminationOn(): boolean {
    return this.mode !== NodeMode.OFF && this.pTermination >= 0 && this.p(this.pTermination) !== 0;
  }

  get state(): number {
    switch (this.mode) {
      case NodeMode.OFF:
      case NodeMode.BOOT:
        return DeviceState.BOOT;
      case NodeMode.BOOTLOADER:
        return DeviceState.BOOTLOADER;
    }
    if (this.estop) return DeviceState.ESTOP;
    if (this.faultActive !== 0) return DeviceState.FAULT;
    return this.isEnabled() ? DeviceState.ACTIVE : DeviceState.IDLE;
  }

  get faults(): { active: number; sticky: number; warn: number } {
    return { active: this.faultActive, sticky: this.faultSticky, warn: this.faultWarn };
  }

  get nameText(): string {
    return decodeName(this.name);
  }

  /** Sends a pre-built frame (request/response path; allocation is fine here). */
  protected send(f: TxFrame): void {
    this.ctx.bus.transmit(this, f.id, f.data, f.data.length, f.fd, f.brs, this.dataBitrateBps());
  }

  /** Sends `len` bytes of `this.tx` (hot path). */
  protected sendRaw(cls: number, index: number, len: number): void {
    const id = makeId(this.def.devType, cls, index, this.num);
    let n = len;
    let fd = false;
    if (len > 8) {
      n = fdRoundUp(len);
      for (let i = len; i < n; i++) this.tx[i] = 0;
      fd = true;
    }
    this.ctx.bus.transmit(this, id, this.tx, n, fd, fd, this.dataBitrateBps());
  }

  private dataBitrateBps(): number {
    return BITRATE_BPS[this.dataBitrate as 0 | 1 | 2 | 3] || 2_000_000;
  }

  protected get addr(): { devType: number; num: number } {
    return { devType: this.def.devType, num: this.num };
  }

  // ---- power and lifecycle ---------------------------------------------------------------

  /** Called every ms with the feed voltage; brown-out powers the board off, recovery boots it. */
  setSupply(v: number): void {
    this.supplyV = v;
    if (this.mode === NodeMode.OFF) {
      if (v >= this.minSupplyV + 0.3) this.boot(false);
    } else if (v < this.minSupplyV) {
      this.powerOff();
    }
  }

  powerOff(): void {
    if (this.mode === NodeMode.APP) this.onAppStop();
    this.mode = NodeMode.OFF;
    this.estop = false;
    this.streamOn = false;
    this.enumAt = -1;
    this.longCmd = -1;
    this.selfTestAt = -1;
    this.identifyUntil = -1;
    this.ctrlSeen = false;
    this.fwPhase = 'idle';
    this.fwBuf = null;
  }

  /** Reboot (command, power-up). RAM is reloaded from flash. */
  reboot(intoBootloader: boolean): void {
    this.powerOff();
    this.boot(intoBootloader);
  }

  private boot(intoBootloader: boolean): void {
    this.mode = NodeMode.BOOT;
    this.bootIntoLoader = intoBootloader || !this.appValid;
    this.bootDoneAt = this.now + (this.bootIntoLoader ? BOOTLOADER_BOOT_MS : BOOT_MS);
  }

  private finishBoot(): void {
    this.num = this.flashNum;
    this.conflict = false;
    this.name.set(this.flashName);
    this.faultActive = 0;
    this.faultWarn = 0;
    if (this.flashCorrupt) {
      // Settings memory failed its CRC: run on catalog defaults until the host saves again.
      this.params.resetFlash();
      this.params.loadDefaults();
      this.flashCorrupt = false;
      this.setFault(FaultBit.PARAM_CRC, true);
    } else {
      this.params.loadFlash();
    }
    this.dataBitrate = this.pDataBitrate >= 0 ? this.p(this.pDataBitrate) : DataBitrate.M2;
    this.hbNext = this.now + this.hbPhase;
    for (let k = 0; k < this.statusNext.length; k++) this.statusNext[k] = this.now + ((this.uid48 >>> 3) + k * 7) % 10;
    this.streamSig.fill(-1);
    this.streamCount = 0;
    if (this.hwFault) this.setFault(FaultBit.HARDWARE, true);
    if (this.bootIntoLoader) {
      this.mode = NodeMode.BOOTLOADER;
      this.fwPhase = 'idle';
    } else {
      this.mode = NodeMode.APP;
      this.onAppStart();
    }
  }

  /** One simulation millisecond. */
  tick(): void {
    const now = this.now;
    if (this.mode === NodeMode.OFF) return;
    if (this.mode === NodeMode.BOOT) {
      if (now < this.bootDoneAt) return;
      this.finishBoot();
    }
    if (this.identifyUntil >= 0 && now >= this.identifyUntil) this.identifyUntil = -1;
    const shorted = this.ctx.bus.shorted;
    if (shorted !== this.canErr) {
      this.canErr = shorted;
      this.setFault(FaultBit.CAN_ERR, shorted);
    }
    if (this.enumAt >= 0 && now >= this.enumAt) {
      this.enumAt = -1;
      this.sendEnumRsp();
    }
    if (this.mode === NodeMode.BOOTLOADER) {
      this.fwTick();
      this.heartbeatTick();
      return;
    }
    if (this.selfTestAt >= 0 && now >= this.selfTestAt) {
      this.selfTestAt = -1;
      this.completeCommand(Command.SELF_TEST, CommandStatus.OK, (this.selfTest() | this.selfTestMask) >>> 0);
    }
    this.appTick();
    if (this.actuator && this.ctrlSeen && now - this.lastCtrlMs > this.p(this.pCtrlTimeout)) {
      this.ctrlSeen = false;
      this.setWarn(FaultBit.CTRL_TIMEOUT, true);
      this.neutral();
    }
    if (this.mode !== NodeMode.APP) return; // an action may have rebooted the board
    this.heartbeatTick();
    if (!this.assigned) return;
    this.statusTick();
    this.streamAdvance(this.streamGranularity < 10 ? this.streamGranularity : 10, 0);
  }

  // ---- receive ---------------------------------------------------------------------------

  receive(f: BusFrame): void {
    if (this.mode === NodeMode.OFF || this.mode === NodeMode.BOOT) return;
    const id = f.id;
    if (idMfr(id) !== MFR) return;
    const cls = idClass(id);
    if ((cls & 1) === 1) {
      if (cls === Cls.SYS_RSP && idIndex(id) === SysRsp.HEARTBEAT) this.checkConflict(f);
      if (this.listensToPeers && this.mode === NodeMode.APP) this.onPeerFrame(f);
      return;
    }
    if (!acceptsFrame(id, this.def.devType, this.num)) return;
    const index = idIndex(id);
    const d = f.data;
    const len = f.len;
    const open = this.assigned;
    switch (cls) {
      case Cls.SYS_REQ:
        this.onSysReq(index, d, len, open);
        return;
      case Cls.CTRL:
        if (open && this.mode === NodeMode.APP && !this.estop && this.onCtrl(index, d, len)) {
          this.lastCtrlMs = this.now;
          this.ctrlSeen = true;
          if (this.faultWarn & (1 << FaultBit.CTRL_TIMEOUT)) this.setWarn(FaultBit.CTRL_TIMEOUT, false);
        }
        return;
      case Cls.PARAM_REQ:
        if (open && this.mode === NodeMode.APP) this.onParamReq(index, d, len);
        return;
      case Cls.STREAM_REQ:
        if (open && this.mode === NodeMode.APP) this.onStreamReq(index, d, len);
        return;
      case Cls.FW_REQ:
        if (open) this.onFwReq(index, d, len);
        return;
    }
  }

  private checkConflict(f: BusFrame): void {
    if (!this.assigned || idDevType(f.id) !== this.def.devType || idNum(f.id) !== this.num || f.len < 5) return;
    if (readU16(f.data, 3) !== this.uid16) {
      this.conflict = true;
      this.streamOn = false;
      this.neutral();
    }
  }

  private onSysReq(index: number, d: Uint8Array, len: number, open: boolean): void {
    switch (index) {
      case SysReq.ENUM_REQ: {
        if (len < 1) return;
        if (d[0] === EnumFilter.UNASSIGNED_OR_CONFLICT && this.assigned) return;
        if (this.enumAt < 0) {
          this.enumAt = this.now + this.enumDelay;
          this.enumRetried = false;
        }
        return;
      }
      case SysReq.ASSIGN_ID: {
        const m = decodeAssignId(d.subarray(0, len));
        if (!m || m.uid48 !== this.uid48 || m.newNum < NUM_MIN || m.newNum > NUM_UNASSIGNED) return;
        this.num = m.newNum;
        if (m.persist) this.flashNum = m.newNum;
        this.conflict = false;
        this.hbNext = this.now + this.hbPhase;
        this.sendEnumRsp();
        return;
      }
      case SysReq.IDENTIFY: {
        const m = decodeIdentify(d.subarray(0, len));
        if (!m) return;
        if (m.kind === 'identifyUid') {
          if (m.uid48 === this.uid48) this.setIdentify(m.seconds);
        } else if (open) this.setIdentify(m.seconds);
        return;
      }
      case SysReq.ESTOP:
        if (len >= 2 && d[0] === 0xe5 && d[1] === 0x70) this.latchEstop();
        return;
    }
    if (!open) return;
    switch (index) {
      case SysReq.INFO_REQ:
        if (len >= 1) this.sendInfo(d[0] ?? 0);
        return;
      case SysReq.NAME_SET: {
        if (len < 8 || this.mode !== NodeMode.APP) return;
        const page = d[0] ?? 0;
        if (page > 2) return;
        for (let i = 0; i < 7; i++) this.name[page * 7 + i] = d[1 + i] ?? 0;
        this.sendInfo(InfoPage.NAME_0 + page);
        return;
      }
      case SysReq.COMMAND: {
        const m = decodeCommand(d.subarray(0, len));
        if (m) this.onCommand(m.cmd, m.arg);
        return;
      }
      case SysReq.FAULT_REQ:
        this.send(encodeFaultRsp(this.addr, { active: this.faultActive, sticky: this.faultSticky, warn: this.faultWarn }));
        return;
    }
  }

  private setIdentify(seconds: number): void {
    this.identifyUntil = seconds > 0 ? this.now + seconds * 1000 : -1;
  }

  get identifying(): boolean {
    return this.identifyUntil >= 0;
  }

  private latchEstop(): void {
    if (this.mode === NodeMode.OFF || this.mode === NodeMode.BOOT) return;
    this.estop = true;
    this.setFault(FaultBit.ESTOP, true);
    this.ctrlSeen = false;
    // neutral() also cancels any running model action; the host learns it failed.
    this.neutral();
    if (this.longCmd >= 0x40) this.completeCommand(this.longCmd, CommandStatus.FAILED, 0);
  }

  // ---- ENUM / INFO -----------------------------------------------------------------------

  private sendEnumRsp(): void {
    const f = encodeEnumRsp(this.addr, {
      uid48: this.uid48,
      num: this.num,
      conflict: this.conflict,
      bootloader: this.mode === NodeMode.BOOTLOADER,
      model: this.def.model,
    });
    this.send(f);
  }

  txError(f: BusFrame): void {
    // PROTOCOL §3.2: a failed ENUM_RSP is retried once after a random 0–100 ms.
    if (idClass(f.id) === Cls.ENUM_RSP && !this.enumRetried && this.enumAt < 0) {
      this.enumRetried = true;
      this.enumAt = this.now + this.rng.int(101);
    }
  }

  private sendInfo(page: number): void {
    const a = this.addr;
    switch (page) {
      case InfoPage.DEVICE:
        this.send(
          encodeInfoRsp(a, {
            section: 'device',
            page: 0,
            model: this.def.model,
            hwRev: this.hwRev,
            protoMajor: PROTO_MAJOR,
            protoMinor: PROTO_MINOR,
            catalogRev: this.def.catalogRev,
            bootloaderVer: 1,
          }),
        );
        return;
      case InfoPage.UID_LO:
      case InfoPage.UID_HI: {
        const pages = uid96ToInfoPages(this.uid96);
        this.send(encodeInfoRsp(a, { section: 'bytes', page, bytes: pages[page - 1]! }));
        return;
      }
      case InfoPage.BUILD:
        this.send(encodeInfoRsp(a, { section: 'build', page: 3, gitHash: this.gitHash, buildDay: this.buildDay, dirty: false }));
        return;
      case InfoPage.NAME_0:
      case InfoPage.NAME_1:
      case InfoPage.NAME_2: {
        const o = (page - InfoPage.NAME_0) * 7;
        this.send(encodeInfoRsp(a, { section: 'bytes', page, bytes: this.name.slice(o, o + 7) }));
        return;
      }
    }
  }

  // ---- COMMAND ---------------------------------------------------------------------------

  private respond(cmd: number, status: number, result: number): void {
    this.send(encodeCommandRsp(this.addr, { cmd, status, result }));
  }

  /** Finishes a long-running command (IN_PROGRESS → OK/FAILED). */
  protected completeCommand(cmd: number, status: number, result: number): void {
    if (this.longCmd === cmd) this.longCmd = -1;
    this.respond(cmd, status, result >>> 0);
  }

  protected get longCommand(): number {
    return this.longCmd;
  }

  private onCommand(cmd: number, arg: number): void {
    const enabled = this.isEnabled();
    if (this.mode === NodeMode.BOOTLOADER) {
      if (cmd === Command.REBOOT) {
        this.respond(cmd, CommandStatus.OK, 0);
        this.reboot(false);
      } else if (cmd === Command.ENTER_BOOTLOADER) this.respond(cmd, CommandStatus.OK, 0);
      else this.respond(cmd, CommandStatus.UNSUPPORTED, 0);
      return;
    }
    switch (cmd) {
      case Command.REBOOT:
        this.respond(cmd, CommandStatus.OK, 0);
        this.reboot(false);
        return;
      case Command.ENTER_BOOTLOADER:
        if (enabled) return this.respond(cmd, CommandStatus.DENIED, 0);
        this.respond(cmd, CommandStatus.OK, 0);
        this.reboot(true);
        return;
      case Command.SAVE_PARAMS:
        if (enabled) return this.respond(cmd, CommandStatus.DENIED, 0);
        if (this.flashWriteFails) return this.respond(cmd, CommandStatus.FAILED, 0);
        this.params.save();
        this.flashName.set(this.name);
        this.setFault(FaultBit.PARAM_CRC, false);
        this.respond(cmd, CommandStatus.OK, 0);
        return;
      case Command.LOAD_DEFAULTS:
        if (enabled) return this.respond(cmd, CommandStatus.DENIED, 0);
        this.params.loadDefaults();
        this.respond(cmd, CommandStatus.OK, 0);
        return;
      case Command.CLEAR_FAULTS:
        this.onClearFaults();
        this.faultSticky = this.faultActive | this.faultWarn;
        this.respond(cmd, CommandStatus.OK, 0);
        return;
      case Command.SELF_TEST:
        if (enabled || this.longCmd >= 0) return this.respond(cmd, CommandStatus.DENIED, 0);
        this.longCmd = cmd;
        this.selfTestAt = this.now + SELF_TEST_MS;
        this.respond(cmd, CommandStatus.IN_PROGRESS, 0);
        return;
      case Command.CLEAR_ESTOP:
        if (this.estop) {
          this.estop = false;
          this.setFault(FaultBit.ESTOP, false);
        }
        this.respond(cmd, CommandStatus.OK, 0);
        return;
    }
    if (cmd < 0x40 || !this.def.actions.some((a) => a.cmd === cmd)) return this.respond(cmd, CommandStatus.UNSUPPORTED, 0);
    const a = this.def.actions.find((x) => x.cmd === cmd)!;
    if (a.longRunning && this.longCmd >= 0) return this.respond(cmd, CommandStatus.DENIED, 0);
    const r = this.action(cmd, arg);
    if (r.status === CommandStatus.IN_PROGRESS) this.longCmd = cmd;
    this.respond(cmd, r.status, r.result >>> 0);
  }

  // ---- PARAM -----------------------------------------------------------------------------

  private onParamReq(index: number, d: Uint8Array, len: number): void {
    if (index === ParamReq.GET) {
      if (len < 2) return;
      const pid = readU16(d, 0);
      const r = this.params.hostGet(pid);
      this.send(encodeParamValue(this.addr, { pid, ptype: r.ptype, status: r.status, value: r.value }));
    } else if (index === ParamReq.SET) {
      if (len < 8) return;
      const pid = readU16(d, 0);
      const ptype = d[2] ?? 0;
      const value = readParamValue(ptype, d, 4);
      const r = this.params.hostSet(pid, ptype, value, this.isEnabled());
      this.send(encodeParamValue(this.addr, { pid, ptype: r.ptype, status: r.status, value: r.value }));
    }
  }

  get unsaved(): boolean {
    if (this.params.unsaved) return true;
    for (let i = 0; i < NAME_BYTES; i++) if (this.name[i] !== this.flashName[i]) return true;
    return false;
  }

  // ---- HEARTBEAT / STATUS ----------------------------------------------------------------

  private heartbeatTick(): void {
    if (!this.assigned || this.now < this.hbNext) return;
    this.hbNext += Timing.HEARTBEAT_MS;
    if (this.hbNext <= this.now) this.hbNext = this.now + Timing.HEARTBEAT_MS;
    const fw = this.appFw;
    this.send(
      encodeHeartbeat(this.addr, {
        state: this.state,
        unsaved: this.mode === NodeMode.APP && this.unsaved,
        enabled: this.mode === NodeMode.APP && this.isEnabled(),
        warning: this.faultWarn !== 0,
        identify: this.identifyUntil >= 0,
        fault: this.faultActive,
        uid16: this.uid16,
        fwMajor: fw.major,
        fwMinor: fw.minor,
        fwPatch: fw.patch,
      }),
    );
  }

  private statusTick(): void {
    const now = this.now;
    for (let k = 0; k < this.statusFrames.length; k++) {
      const period = this.p(this.statusPeriodIdx[k]!);
      if (period <= 0) continue;
      if (now < this.statusNext[k]!) continue;
      this.statusNext[k] = this.statusNext[k]! + period <= now ? now + period : this.statusNext[k]! + period;
      const sf = this.statusFrames[k]!;
      sf.encode(this.sig, this.tx);
      this.sendRaw(Cls.STATUS, sf.index, 8);
    }
  }

  // ---- STREAM ----------------------------------------------------------------------------

  private onStreamReq(index: number, d: Uint8Array, len: number): void {
    switch (index) {
      case StreamReq.CONFIG: {
        if (len < 3) return;
        const slot = d[0] ?? 0;
        if (slot >= STREAM_SLOTS) return;
        const sid = readU16(d, 1);
        if (sid === STREAM_SID_CLEAR) this.streamSig[slot] = -1;
        else {
          const i = this.def.signals.findIndex((s) => s.sid === sid);
          if (i < 0) return;
          this.streamSig[slot] = i;
        }
        let n = 0;
        while (n < STREAM_SLOTS && this.streamSig[n]! >= 0) n++;
        this.streamCount = n;
        return;
      }
      case StreamReq.START: {
        if (len < 2) return;
        const min = Math.max(1, Math.ceil(this.def.stream.minPeriodUs / 100));
        const g = this.streamGranularity;
        let per = Math.max(min, readU16(d, 0));
        per = Math.max(Math.ceil(min / g) * g, Math.round(per / g) * g);
        if (!this.streamOn || per !== this.streamPeriod) {
          this.streamAcc = per; // first sample at the next sampling instant
          this.streamPeriod = per;
        }
        this.streamOn = true;
        this.streamLastStart = this.now;
        return;
      }
      case StreamReq.STOP:
        this.streamOn = false;
        return;
    }
  }

  get streaming(): boolean {
    return this.streamOn;
  }

  get streamPeriod100us(): number {
    return this.streamPeriod;
  }

  /**
   * Advances the stream sampler by `elapsed100us`; `subOffset100us` places the sample inside
   * the current millisecond (boards with sub-ms streams call this from their fast loop).
   */
  protected streamAdvance(elapsed100us: number, subOffset100us: number): void {
    if (!this.streamOn || this.streamCount === 0 || !this.assigned || this.mode !== NodeMode.APP) return;
    if (this.now - this.streamLastStart > Timing.STREAM_TIMEOUT_MS) {
      this.streamOn = false;
      return;
    }
    this.streamAcc += elapsed100us;
    if (this.streamAcc < this.streamPeriod) return;
    this.streamAcc -= this.streamPeriod;
    if (this.streamAcc > this.streamPeriod) this.streamAcc = 0;
    const t = (Math.round(this.now * 10) + subOffset100us) & 0xffff;
    const seq = this.streamSeq;
    this.streamSeq = (seq + 1) & 0xff;
    const tx = this.tx;
    if (this.fdMode) {
      const k = this.streamCount;
      tx[0] = seq;
      tx[1] = 0;
      writeU16(tx, 2, t);
      for (let s = 0; s < k; s++) writeF32(tx, 4 + 4 * s, this.sig[this.streamSig[s]!] ?? 0);
      this.sendRaw(Cls.STREAM_RSP, 0, 4 + 4 * k);
    } else {
      for (let s = 0; s < this.streamCount; s++) {
        tx[0] = seq;
        tx[1] = s;
        writeU16(tx, 2, t);
        writeF32(tx, 4, this.sig[this.streamSig[s]!] ?? 0);
        this.sendRaw(Cls.STREAM_RSP, 0, 8);
      }
    }
  }

  // ---- FW update -------------------------------------------------------------------------

  private fwAck(status: number, next = this.fwNext): void {
    this.send(encodeFwAck(this.addr, { status, window: FW_WINDOW_DEFAULT, nextOffset: next }));
  }

  private onFwReq(index: number, d: Uint8Array, len: number): void {
    if (this.mode !== NodeMode.BOOTLOADER) return this.fwAck(FwStatus.WRONG_STATE, 0);
    switch (index) {
      case FwReq.BEGIN: {
        if (len < 8) return;
        const size = readU32(d, 0);
        if (size < 64 || size > FW_MAX_SIZE) return this.fwAck(FwStatus.BAD_IMAGE, 0);
        this.fwSize = size;
        this.fwCrc = readU32(d, 4);
        this.fwBuf = new Uint8Array(size);
        this.fwNext = 0;
        this.fwSinceAck = 0;
        this.fwBadOffsetSent = false;
        // Erasing destroys the application: an interrupted update leaves the board in the bootloader.
        this.appValid = false;
        this.fwPhase = 'erasing';
        this.fwPhaseDoneAt = this.now + 60 + Math.ceil(size / 2048) * 4;
        this.fwAck(FwStatus.BUSY, 0);
        return;
      }
      case FwReq.DATA: {
        if (this.fwPhase === 'erasing' || this.fwPhase === 'verifying') return this.fwAck(FwStatus.BUSY);
        if (this.fwPhase !== 'receiving' || !this.fwBuf || len < 4) return this.fwAck(FwStatus.WRONG_STATE);
        const off = readU24(d, 0);
        if (off !== this.fwNext) {
          if (!this.fwBadOffsetSent) {
            this.fwBadOffsetSent = true;
            this.fwAck(FwStatus.BAD_OFFSET);
          }
          return;
        }
        this.fwBadOffsetSent = false;
        const chunk = len - 3;
        const n = Math.min(chunk, this.fwSize - off);
        for (let i = 0; i < n; i++) this.fwBuf[off + i] = d[3 + i] ?? 0;
        this.fwNext = off + n;
        this.fwSinceAck++;
        if (this.flashWriteFails) {
          this.fwPhase = 'idle';
          return this.fwAck(FwStatus.FLASH_ERROR);
        }
        if (this.fwSinceAck >= FW_WINDOW_DEFAULT || this.fwNext >= this.fwSize) {
          this.fwSinceAck = 0;
          this.fwAck(FwStatus.OK);
        }
        return;
      }
      case FwReq.END: {
        if (this.fwPhase !== 'receiving' || !this.fwBuf) return this.fwAck(FwStatus.WRONG_STATE);
        if (this.fwNext < this.fwSize) return this.fwAck(FwStatus.BAD_OFFSET);
        this.fwPhase = 'verifying';
        this.fwPhaseDoneAt = this.now + FW_VERIFY_MS;
        return;
      }
    }
  }

  private fwTick(): void {
    if (this.now < this.fwPhaseDoneAt) return;
    if (this.fwPhase === 'erasing') {
      this.fwPhase = 'receiving';
      this.fwAck(FwStatus.OK, 0);
    } else if (this.fwPhase === 'verifying') {
      this.fwPhase = 'idle';
      const buf = this.fwBuf!;
      this.fwBuf = null;
      if (crc32(buf) !== this.fwCrc) return this.fwAck(FwStatus.BAD_CRC);
      const v = validateCyfw(buf, { model: this.def.model, hwRev: this.hwRev });
      if (!v.ok) return this.fwAck(FwStatus.BAD_IMAGE);
      this.appFw = { major: v.header.fwMajor, minor: v.header.fwMinor, patch: v.header.fwPatch };
      this.gitHash = v.header.gitHash;
      this.buildDay = v.header.buildDay;
      this.appValid = true;
      this.fwAck(FwStatus.OK);
      this.reboot(false);
    }
  }

  get fwProgress(): { phase: string; received: number; size: number } {
    return { phase: this.fwPhase, received: this.fwNext, size: this.fwSize };
  }

  /** Back to factory state: number 63, default settings, no name; then reboots. */
  factoryReset(): void {
    this.flashNum = NUM_UNASSIGNED;
    this.flashName.fill(0);
    this.params.resetFlash();
    if (this.mode !== NodeMode.OFF) this.reboot(false);
  }

  /** Sets the persisted number directly (scenario setup, conflict demos); applied at next boot. */
  setFlashNum(num: number): void {
    this.flashNum = num;
    if (this.mode === NodeMode.OFF) this.num = num;
  }

  // ---- injection & snapshot --------------------------------------------------------------

  /** Panel fault injection. Returns false if this board does not support the kind. */
  inject(kind: InjectionKind, on = true, arg = 0): boolean {
    switch (kind) {
      case 'paramCrc':
        this.flashCorrupt = on;
        return true;
      case 'hardware':
        this.hwFault = on;
        if (this.mode === NodeMode.APP) this.setFault(FaultBit.HARDWARE, on);
        return true;
      case 'selfTestFail':
        this.selfTestMask = on ? (arg || 1) : 0;
        return true;
      case 'flashError':
        this.flashWriteFails = on;
        return true;
    }
    return this.injectModel(kind, on, arg);
  }

  allInjections(): InjectionKind[] {
    return [...COMMON_INJECTIONS, ...this.supportedInjections()];
  }

  activeInjections(): InjectionKind[] {
    const out: InjectionKind[] = [];
    if (this.flashCorrupt) out.push('paramCrc');
    if (this.hwFault) out.push('hardware');
    if (this.selfTestMask) out.push('selfTestFail');
    if (this.flashWriteFails) out.push('flashError');
    return [...out, ...this.activeModelInjections()];
  }

  signalValues(): Record<string, number> {
    const out: Record<string, number> = {};
    this.def.signals.forEach((s, i) => (out[s.key] = this.sig[i] ?? 0));
    return out;
  }

  snapshot(connected: boolean): NodeSnapshot {
    const modeName = (['off', 'boot', 'app', 'bootloader'] as const)[this.mode];
    return {
      id: this.id,
      model: this.def.model,
      modelKey: this.def.key,
      devType: this.def.devType,
      num: this.num,
      uid48: this.uid48,
      uid48Hex: this.uid48.toString(16).padStart(12, '0'),
      name: this.nameText,
      state: this.state,
      mode: modeName,
      powered: this.mode !== NodeMode.OFF,
      connected,
      conflict: this.conflict,
      identify: this.identifying,
      enabled: this.mode === NodeMode.APP && this.isEnabled(),
      unsaved: this.unsaved,
      faults: this.faults,
      fw: this.firmware,
      supplyV: this.supplyV,
      supplyA: this.supplyCurrent(),
      streaming: this.streamOn,
      signals: this.signalValues(),
      injections: this.allInjections(),
      activeInjections: this.activeInjections(),
    };
  }

  /** Reads an f32 from a peer STATUS payload (helper for listening boards). */
  protected static peerF32(f: BusFrame, offset: number): number {
    return readF32(f.data, offset);
  }
}

function makeId(devType: number, cls: number, index: number, num: number): number {
  return (((devType & 0x1f) << 24) | ((MFR & 0xff) << 16) | ((cls & 0x3f) << 10) | ((index & 0x0f) << 6) | (num & 0x3f)) >>> 0;
}

/** Deterministic UID from the node id when no seed-derived UID is supplied. */
function placeholderUid(id: string): Uint8Array {
  const b = new Uint8Array(12);
  let h = 0x811c9dc5;
  for (let i = 0; i < 12; i++) {
    for (let k = 0; k < id.length; k++) h = Math.imul(h ^ id.charCodeAt(k), 0x01000193) >>> 0;
    h = Math.imul(h ^ i, 0x01000193) >>> 0;
    b[i] = h & 0xff;
  }
  return b;
}
