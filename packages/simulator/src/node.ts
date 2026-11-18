import {
  Cls,
  Command,
  CommandStatus,
  CommonPid,
  DataBitrate,
  DevType,
  DeviceState,
  ENTER_BOOTLOADER_INTENT,
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
  NUM_BROADCAST,
  NUM_UNASSIGNED,
  PROTO_MAJOR,
  PROTO_MINOR,
  ParamReq,
  RECOVERY_STAY_MAGIC,
  RECOVERY_WINDOW_MS,
  STREAM_MAX_SLOTS_CLASSIC,
  STREAM_SID_CLEAR,
  STREAM_SLOTS,
  StreamReq,
  SysReq,
  SysRsp,
  Timing,
  acceptsFrame,
  CYFW_HEADER_SIZE,
  crc32,
  decodeAssignId,
  decodeCyfwHeader,
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
  isValidFdLength,
  idClass,
  idDevType,
  idIndex,
  idMfr,
  idNum,
  readU16,
  readU24,
  readU32,
  readU48,
  readParamValue,
  statusPeriodPid,
  uid96ToInfoPages,
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
  | 'flashError'
  | 'brokenApp';

export const COMMON_INJECTIONS: readonly InjectionKind[] = ['paramCrc', 'hardware', 'selfTestFail', 'flashError', 'brokenApp'];

/**
 * What a board made of a CTRL frame (same contract as the C library's `ctrl` callback).
 * INVALID frames are ignored altogether; DRIVE is applied only once the index is armed by a
 * NEUTRAL command (PROTOCOL §7, neutral-first rule).
 */
export const CtrlResult = { INVALID: 0, NEUTRAL: 1, DRIVE: 2 } as const;
export type CtrlResult = (typeof CtrlResult)[keyof typeof CtrlResult];

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
/** Bootloader start-up when it stays (ENTER_BOOTLOADER, no valid image): no recovery window. */
const BOOTLOADER_BOOT_MS = 10;
const SELF_TEST_MS = 300;
const FW_MAX_SIZE = 1 << 20;
const FW_VERIFY_MS = 40;
/** Verified image until the application starts (FW_REQ answers BUSY meanwhile). */
const FW_START_DELAY_MS = 5;
/** Signed `.cyfw`: a 64-byte signature follows the payload (PROTOCOL §9.1, flags bit0). */
const CYFW_SIGNATURE_SIZE = 64;
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
  /** The installed image passes its CRC but hangs before CAN comes up (recovery-window demo). */
  private appBroken = false;

  // Runtime state.
  mode: NodeMode = NodeMode.OFF;
  num: number;
  readonly name = new Uint8Array(NAME_BYTES);
  conflict = false;
  private bootDoneAt = 0;
  private bootIntoLoader = false;
  /** Bootloader is in its power-up recovery window (PROTOCOL §9.0). */
  private recoveryWindow = false;
  /** The application hung at start-up (broken image): the board stays silent until power-cycled. */
  private hung = false;
  /** Next heartbeat reports state BOOT (first one after the application starts, PROTOCOL §4.1). */
  private bootHeartbeat = false;
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
  private clearStickyAt = -1;
  private ctrlSeen = false;
  private lastCtrlMs = 0;
  /** Bit per CTRL index: a neutral command was seen since the last neutral-forcing event. */
  private ctrlArmed = 0;
  private inNeutral = false;
  /** Time ESTOP was last latched: a CLEAR_ESTOP in the same processing turn loses (PROTOCOL §4.7). */
  private estopAt = -1;
  private canErr = false;

  // Status frames.
  private readonly statusFrames: CompiledStatusFrame[];
  private readonly statusPeriodIdx: number[];
  private readonly statusNext: number[];

  // Stream.
  /** Slot → configured sid (-1 = empty). */
  private readonly streamSid = new Int32Array(STREAM_SLOTS).fill(-1);
  /** Slot → signal index; -1 for a sid the board does not know (streams NaN, like the C library). */
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
  /**
   * header: BEGIN accepted, the 64-byte header is collected in RAM and nothing is erased yet ·
   * erasing (BUSY) · receiving · verifying and starting (`END` given; BUSY to every FW_REQ).
   */
  private fwPhase: 'idle' | 'header' | 'erasing' | 'receiving' | 'verifying' | 'starting' = 'idle';
  private fwBuf: Uint8Array | null = null;
  private fwSize = 0;
  private fwCrc = 0;
  private fwNext = 0;
  private fwSinceAck = 0;
  private fwPhaseDoneAt = 0;
  /** Out-of-order DATA frames since the last BAD_OFFSET; one BAD_OFFSET per window of them. */
  private fwBadCount = 0;
  /** Whether a pending start (REBOOT answered, verified image) may still run. */
  private fwStartAt = -1;

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
    // Same phase rule as the C library, so both send at the same instants.
    this.hbPhase = this.uid16 % (Timing.HEARTBEAT_PHASE_MAX_MS + 1);
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
  /**
   * CTRL frame for this board. Classify it and apply it, except a DRIVE command while
   * `armed` is false (the base class then ignores it: neutral-first rule, PROTOCOL §7).
   */
  protected onCtrl(_index: number, _data: Uint8Array, _len: number, _armed: boolean): CtrlResult {
    return CtrlResult.INVALID;
  }
  /** Actuator outputs to neutral (ESTOP, timeout, fault, conflict, renumbering). */
  protected neutral(): void {}
  /** Frames other boards send (STATUS, HEARTBEAT…), for boards that listen to peers. */
  protected onPeerFrame(_f: BusFrame): void {}
  protected readonly listensToPeers: boolean = false;
  /**
   * False for boards running another protocol (legacy Cyncoder v3): the base class then only
   * boots and powers them and runs `appTick`; they override `receive` and send their own frames.
   */
  protected readonly speaksCyCan: boolean = true;
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

  /** A new active fault forces the actuators neutral and disarms CTRL (PROTOCOL §7). */
  protected setFault(bit: number, on: boolean): void {
    const m = 1 << bit;
    if (on) {
      const fresh = (this.faultActive & m) === 0;
      this.faultActive |= m;
      this.faultSticky |= m;
      if (fresh && bit !== FaultBit.ESTOP) this.forceNeutral();
    } else this.faultActive &= ~m;
  }

  /** Warnings are not sticky (same as the C library); CAN_ERR is, so a brief loss stays visible. */
  protected setWarn(bit: number, on: boolean): void {
    const m = 1 << bit;
    if (on) {
      this.faultWarn |= m;
      if (bit === FaultBit.CAN_ERR) this.faultSticky |= m;
    } else this.faultWarn &= ~m;
  }

  /** Every neutral-forcing event: outputs neutral, watchdog off, every CTRL index disarmed. */
  private forceNeutral(): void {
    this.ctrlArmed = 0;
    this.ctrlSeen = false;
    if (this.inNeutral) return;
    this.inNeutral = true; // neutral() may raise a fault, which lands here again
    this.neutral();
    this.inNeutral = false;
  }

  /** CTRL is accepted at all: running, assigned, not ESTOP-latched, no active fault. */
  private get ctrlAllowed(): boolean {
    return this.mode === NodeMode.APP && this.assigned && !this.estop && this.faultActive === 0;
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

  /** Hangs at start-up: the installed image is broken (`brokenApp` injection). */
  get hangs(): boolean {
    return this.hung;
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

  /** `can.data_bitrate` from flash; classic when the model has no such setting or the store is corrupt. */
  private storedDataBitrate(): number {
    if (this.pDataBitrate < 0 || this.flashCorrupt) return DataBitrate.CLASSIC;
    return this.params.flash[this.pDataBitrate] ?? DataBitrate.CLASSIC;
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
    this.estopAt = -1;
    this.streamOn = false;
    this.enumAt = -1;
    this.longCmd = -1;
    this.selfTestAt = -1;
    this.identifyUntil = -1;
    this.ctrlSeen = false;
    this.ctrlArmed = 0;
    this.recoveryWindow = false;
    this.hung = false;
    this.bootHeartbeat = false;
    this.fwPhase = 'idle';
    this.fwBuf = null;
    this.fwStartAt = -1;
  }

  /** Reboot (command, power-up). RAM is reloaded from flash. */
  reboot(intoBootloader: boolean): void {
    this.powerOff();
    this.boot(intoBootloader);
  }

  /**
   * Power-up runs the bootloader first. With a valid image and no request to stay, it listens
   * for the recovery beacon for RECOVERY_WINDOW_MS (PROTOCOL §9.0) and then starts the app.
   */
  private boot(intoBootloader: boolean): void {
    this.mode = NodeMode.BOOT;
    this.bootIntoLoader = intoBootloader || !this.appValid;
    this.recoveryWindow = !this.bootIntoLoader;
    this.bootDoneAt = this.now + (this.bootIntoLoader ? BOOTLOADER_BOOT_MS : RECOVERY_WINDOW_MS);
  }

  private finishBoot(): void {
    this.recoveryWindow = false;
    if (!this.bootIntoLoader && this.appBroken) {
      // CRC-valid image that crashes before CAN comes up: silent until the next power-up.
      this.hung = true;
      this.bootDoneAt = Number.POSITIVE_INFINITY;
      return;
    }
    if (this.flashCorrupt) {
      // Settings store failed its CRC (number, name and parameters live there, as in the C
      // library): the board comes up unassigned on catalog defaults, PARAM_CRC active, so it
      // cannot be driven under its old number with possibly wrong settings.
      this.flashNum = NUM_UNASSIGNED;
      this.flashName.fill(0);
      this.params.resetFlash();
    }
    this.num = this.flashNum;
    this.conflict = false;
    this.name.set(this.flashName);
    this.faultActive = 0;
    this.faultWarn = 0;
    this.params.loadFlash();
    // can.data_bitrate is reboot-required: the value loaded now stays in effect. The bootloader
    // reads the store itself and falls back on classic when it is corrupt (PROTOCOL §9).
    if (this.bootIntoLoader) this.dataBitrate = this.storedDataBitrate();
    else this.dataBitrate = this.pDataBitrate >= 0 ? this.p(this.pDataBitrate) : DataBitrate.CLASSIC;
    this.hbNext = this.now + this.hbPhase;
    for (let k = 0; k < this.statusNext.length; k++) this.statusNext[k] = this.now + ((this.uid48 >>> 3) + k * 7) % 10;
    this.streamSid.fill(-1);
    this.streamSig.fill(-1);
    this.streamCount = 0;
    this.ctrlArmed = 0;
    this.ctrlSeen = false;
    if (this.bootIntoLoader) {
      this.mode = NodeMode.BOOTLOADER;
      this.fwPhase = 'idle';
      this.fwStartAt = -1;
      return;
    }
    this.mode = NodeMode.APP;
    this.bootHeartbeat = this.assigned;
    if (this.flashCorrupt) this.setFault(FaultBit.PARAM_CRC, true);
    if (this.hwFault) this.setFault(FaultBit.HARDWARE, true);
    this.onAppStart();
  }

  /** PROTOCOL §9.0: the one frame a bootloader in its recovery window acts on. */
  private isRecoveryBeacon(f: BusFrame): boolean {
    const id = f.id;
    if (idClass(id) !== Cls.SYS_REQ || idIndex(id) !== SysReq.COMMAND) return false;
    if (idDevType(id) !== DevType.BROADCAST || idNum(id) !== NUM_BROADCAST) return false;
    const m = decodeCommand(f.data.subarray(0, f.len));
    return m !== null && m.cmd === Command.ENTER_BOOTLOADER && m.arg >>> 0 === RECOVERY_STAY_MAGIC;
  }

  /** One simulation millisecond. */
  tick(): void {
    const now = this.now;
    if (this.mode === NodeMode.OFF) return;
    if (this.mode === NodeMode.BOOT) {
      if (now < this.bootDoneAt) return;
      this.finishBoot();
      if (this.mode === NodeMode.BOOT) return;
    }
    if (this.identifyUntil >= 0 && now >= this.identifyUntil) this.identifyUntil = -1;
    const shorted = this.ctx.bus.shorted;
    if (shorted !== this.canErr) {
      this.canErr = shorted;
      this.setWarn(FaultBit.CAN_ERR, shorted);
    }
    if (!this.speaksCyCan) {
      this.appTick();
      return;
    }
    if (this.enumAt >= 0 && now >= this.enumAt) {
      this.enumAt = -1;
      this.sendEnumRsp();
    }
    if (this.mode === NodeMode.BOOTLOADER) {
      this.fwTick();
      if (this.mode === NodeMode.BOOTLOADER) this.heartbeatTick();
      return;
    }
    if (this.selfTestAt >= 0 && now >= this.selfTestAt) {
      this.selfTestAt = -1;
      this.completeCommand(Command.SELF_TEST, CommandStatus.OK, (this.selfTest() | this.selfTestMask) >>> 0);
    }
    this.appTick();
    if (this.clearStickyAt >= 0 && now >= this.clearStickyAt) {
      this.clearStickyAt = -1;
      this.faultSticky &= this.faultActive;
    }
    if (this.actuator && this.ctrlSeen && now - this.lastCtrlMs > this.p(this.pCtrlTimeout)) {
      this.setWarn(FaultBit.CTRL_TIMEOUT, true);
      this.forceNeutral();
    }
    if (this.mode !== NodeMode.APP) return; // an action may have rebooted the board
    this.heartbeatTick();
    if (!this.assigned) return;
    this.statusTick();
    this.streamAdvance(this.streamGranularity < 10 ? this.streamGranularity : 10, 0);
  }

  // ---- receive ---------------------------------------------------------------------------

  receive(f: BusFrame): void {
    if (this.mode === NodeMode.OFF) return;
    if (this.mode === NodeMode.BOOT) {
      if (this.recoveryWindow && this.speaksCyCan && this.isRecoveryBeacon(f)) {
        this.bootIntoLoader = true;
        this.finishBoot();
        this.hbNext = this.now; // announce the bootloader right away
      }
      return;
    }
    const id = f.id;
    if (idMfr(id) !== MFR) return;
    const cls = idClass(id);
    if ((cls & 1) === 1) {
      if (cls === Cls.SYS_RSP && idIndex(id) === SysRsp.HEARTBEAT) this.checkConflict(f);
      else if (cls === Cls.ENUM_RSP) this.checkEnumConflict(f);
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
        this.onSysReq(index, d, len, open, idNum(id) === NUM_BROADCAST);
        return;
      case Cls.CTRL:
        this.onCtrlFrame(id, index, d, len);
        return;
      case Cls.PARAM_REQ:
        if (open && this.mode === NodeMode.APP) this.onParamReq(index, d, len);
        return;
      case Cls.STREAM_REQ:
        if (open && this.mode === NodeMode.APP) this.onStreamReq(index, d, len);
        return;
      case Cls.FW_REQ:
        if (!open) return;
        if (this.mode === NodeMode.APP) return this.fwAck(FwStatus.WRONG_STATE, 0);
        // The bootloader takes FW frames only at its own number: a broadcast would reflash
        // every board sitting in its bootloader at once.
        if (idNum(id) === this.num) this.onFwReq(index, d, len);
        return;
    }
  }

  private onCtrlFrame(id: number, index: number, d: Uint8Array, len: number): void {
    // PROTOCOL §7: CTRL is addressed to one board; both broadcast forms are ignored.
    if (idNum(id) === NUM_BROADCAST || idDevType(id) === DevType.BROADCAST) return;
    if (!this.ctrlAllowed) return;
    const bit = 1 << index;
    const armed = (this.ctrlArmed & bit) !== 0;
    const r = this.onCtrl(index, d, len, armed);
    // Only valid frames feed the watchdog; a drive command before the neutral one is ignored.
    if (r === CtrlResult.INVALID || (r === CtrlResult.DRIVE && !armed)) return;
    if (!this.ctrlAllowed) return; // applying it raised a fault
    if (r === CtrlResult.NEUTRAL) this.ctrlArmed |= bit;
    this.lastCtrlMs = this.now;
    this.ctrlSeen = true;
    if (this.faultWarn & (1 << FaultBit.CTRL_TIMEOUT)) this.setWarn(FaultBit.CTRL_TIMEOUT, false);
  }

  private checkConflict(f: BusFrame): void {
    if (!this.assigned || idDevType(f.id) !== this.def.devType || idNum(f.id) !== this.num || f.len < 8) return;
    if (readU16(f.data, 3) !== this.uid16) this.enterConflict();
  }

  /** PROTOCOL §3.4: an ENUM_RSP carrying our DEVTYPE+NUM from another uid48 is a conflict too. */
  private checkEnumConflict(f: BusFrame): void {
    if (!this.assigned || idDevType(f.id) !== this.def.devType || f.len < 8) return;
    const flags = f.data[6] ?? 0;
    if ((flags & 0x3f) !== this.num || readU48(f.data, 0) === this.uid48) return;
    this.enterConflict();
  }

  private enterConflict(): void {
    this.conflict = true;
    this.streamOn = false;
    this.forceNeutral();
    // Announce it so every board on this number falls silent, whatever the boot order.
    this.enumAt = this.now + this.rng.int(21);
    this.enumRetried = false;
  }

  private onSysReq(index: number, d: Uint8Array, len: number, open: boolean, broadcast: boolean): void {
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
        // A persistent assignment erases flash, which stalls a single-bank MCU (and a motor's
        // commutation): refused while driving, without confirmation (same as the C library).
        if (m.persist && this.mode === NodeMode.APP && this.isEnabled()) return;
        const wasOpen = this.assigned;
        const old = this.num;
        this.num = m.newNum;
        if (m.persist) this.flashNum = m.newNum;
        // An active board changing its address loses its controller: it stops driving and streaming.
        if (wasOpen && old !== m.newNum) {
          this.streamOn = false;
          this.forceNeutral();
        }
        this.conflict = false;
        this.bootHeartbeat = false;
        // The confirmation below replaces any reply or conflict announcement still pending.
        this.enumAt = -1;
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
        if (this.mode === NodeMode.APP && len >= 2 && d[0] === 0xe5 && d[1] === 0x70) this.latchEstop();
        return;
    }
    if (!open) return;
    const loader = this.mode === NodeMode.BOOTLOADER;
    switch (index) {
      case SysReq.INFO_REQ:
        // The bootloader only knows the device and UID pages (PROTOCOL §9).
        if (len >= 1 && (!loader || (d[0] ?? 0) <= InfoPage.UID_HI)) this.sendInfo(d[0] ?? 0);
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
        if (m) this.onCommand(m.cmd, m.arg >>> 0, broadcast);
        return;
      }
      case SysReq.FAULT_REQ:
        if (loader) return;
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
    if (this.mode !== NodeMode.APP) return;
    this.estopAt = this.now;
    const pending = this.longCmd;
    this.longCmd = -1;
    this.selfTestAt = -1;
    if (!this.estop) {
      this.estop = true;
      this.setFault(FaultBit.ESTOP, true);
      // neutral() also cancels any running model action.
      this.forceNeutral();
    }
    // PROTOCOL §4.5: a long command running when ESTOP arrives ends with FAILED.
    if (pending >= 0) this.respond(pending, CommandStatus.FAILED, 0);
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
    // A command ESTOP already ended with FAILED gets no second answer.
    if (this.longCmd !== cmd) return;
    this.longCmd = -1;
    this.respond(cmd, status, result >>> 0);
  }

  protected get longCommand(): number {
    return this.longCmd;
  }

  private onCommand(cmd: number, arg: number, broadcast: boolean): void {
    if (this.mode === NodeMode.BOOTLOADER) {
      // Only REBOOT is answered in the bootloader; everything else stays silent (PROTOCOL §9).
      // Leaving it only makes sense with a valid image to start.
      if (cmd !== Command.REBOOT) return;
      if (!this.appValid) return this.respond(cmd, CommandStatus.FAILED, 0);
      this.respond(cmd, CommandStatus.OK, 0);
      this.fwStartAt = this.now + FW_START_DELAY_MS;
      return;
    }
    const enabled = this.isEnabled();
    switch (cmd) {
      case Command.ENTER_BOOTLOADER:
        // Studio's recovery beacon (PROTOCOL §9.0) is for bootloaders starting up: ignored here.
        if (broadcast && arg === RECOVERY_STAY_MAGIC) return;
      // falls through
      case Command.REBOOT:
        // ESTOP is only lifted by CLEAR_ESTOP or a power cut, so a reset is refused too.
        if (enabled || this.estop) return this.respond(cmd, CommandStatus.DENIED, 0);
        if (cmd === Command.ENTER_BOOTLOADER && arg !== (ENTER_BOOTLOADER_INTENT | this.uid16) >>> 0) {
          return this.respond(cmd, CommandStatus.INVALID_ARG, 0);
        }
        this.respond(cmd, CommandStatus.OK, 0);
        this.reboot(cmd === Command.ENTER_BOOTLOADER);
        return;
      case Command.SAVE_PARAMS:
        if (enabled) return this.respond(cmd, CommandStatus.DENIED, 0);
        if (this.flashWriteFails) return this.respond(cmd, CommandStatus.FAILED, 0);
        this.params.save();
        this.flashName.set(this.name);
        this.flashCorrupt = false;
        this.setFault(FaultBit.PARAM_CRC, false);
        this.respond(cmd, CommandStatus.OK, 0);
        return;
      case Command.LOAD_DEFAULTS:
        if (enabled) return this.respond(cmd, CommandStatus.DENIED, 0);
        this.params.loadDefaults();
        this.respond(cmd, CommandStatus.OK, 0);
        return;
      case Command.LOAD_SAVED:
        // Back to the stored settings (parameters and name); unsaved changes are dropped.
        if (enabled) return this.respond(cmd, CommandStatus.DENIED, 0);
        if (this.flashCorrupt) return this.respond(cmd, CommandStatus.FAILED, 0);
        this.params.loadFlash();
        this.name.set(this.flashName);
        this.respond(cmd, CommandStatus.OK, 0);
        return;
      case Command.CLEAR_FAULTS:
        this.onClearFaults();
        // PARAM_CRC is a latched condition, not a live one: clearing it is the operator's
        // acknowledgement that the defaults are in use (same as the C library).
        this.setFault(FaultBit.PARAM_CRC, false);
        this.faultSticky = this.faultActive;
        // Latched model faults released above drop out of `faultActive` at the next app step;
        // only what is still active then stays sticky.
        this.clearStickyAt = this.now + 1;
        this.respond(cmd, CommandStatus.OK, 0);
        return;
      case Command.CLEAR_ESTOP:
        // PROTOCOL §4.7: an ESTOP latched in the same processing turn wins.
        if (this.estop && this.estopAt === this.now) return this.respond(cmd, CommandStatus.DENIED, 0);
        if (this.estop) {
          this.estop = false;
          this.setFault(FaultBit.ESTOP, false);
          this.ctrlArmed = 0; // the target that was flowing before ESTOP must not resume
        }
        this.respond(cmd, CommandStatus.OK, 0);
        return;
    }
    if (this.longCmd >= 0) {
      // A repeat of the running command (host retry after a lost reply) gets the progress
      // answer again; anything else waits for it to finish.
      return this.respond(cmd, cmd === this.longCmd ? CommandStatus.IN_PROGRESS : CommandStatus.DENIED, 0);
    }
    if (cmd === Command.SELF_TEST) {
      if (enabled) return this.respond(cmd, CommandStatus.DENIED, 0);
      this.longCmd = cmd;
      this.selfTestAt = this.now + SELF_TEST_MS;
      this.respond(cmd, CommandStatus.IN_PROGRESS, 0);
      return;
    }
    if (cmd < 0x40 || !this.def.actions.some((a) => a.cmd === cmd)) return this.respond(cmd, CommandStatus.UNSUPPORTED, 0);
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
    // A corrupt store holds nothing: whatever runs now is not saved.
    if (this.flashCorrupt || this.params.unsaved) return true;
    for (let i = 0; i < NAME_BYTES; i++) if (this.name[i] !== this.flashName[i]) return true;
    return false;
  }

  // ---- HEARTBEAT / STATUS ----------------------------------------------------------------

  private heartbeatTick(): void {
    if (!this.assigned || this.now < this.hbNext) return;
    this.hbNext += Timing.HEARTBEAT_MS;
    if (this.hbNext <= this.now) this.hbNext = this.now + Timing.HEARTBEAT_MS;
    // PROTOCOL §9: the bootloader reports the installed image, 0.0.0 once it was erased.
    const fw = this.appValid ? this.appFw : { major: 0, minor: 0, patch: 0 };
    // PROTOCOL §4.1: the first heartbeat after the application starts says BOOT, so the host
    // knows the board restarted even when it never missed a heartbeat.
    const state = this.mode === NodeMode.APP && this.bootHeartbeat ? DeviceState.BOOT : this.state;
    this.bootHeartbeat = false;
    this.send(
      encodeHeartbeat(this.addr, {
        state,
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
        // An unknown sid still takes its slot (value NaN): the host maps DATA values to slots
        // by position, so skipping it would shift every later slot.
        this.streamSid[slot] = sid === STREAM_SID_CLEAR ? -1 : sid;
        this.streamSig[slot] = sid === STREAM_SID_CLEAR ? -1 : this.def.signals.findIndex((s) => s.sid === sid);
        let n = 0;
        while (n < STREAM_SLOTS && this.streamSid[n]! >= 0) n++;
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

  private streamValue(slot: number): number {
    const i = this.streamSig[slot]!;
    return i >= 0 ? (this.sig[i] ?? 0) : Number.NaN;
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
      for (let s = 0; s < k; s++) writeF32(tx, 4 + 4 * s, this.streamValue(s));
      this.sendRaw(Cls.STREAM_RSP, 0, 4 + 4 * k);
    } else {
      // Classic mode sends a frame per slot; more than STREAM_MAX_SLOTS_CLASSIC would not fit
      // the bus (PROTOCOL §8), the rest stay configured but silent.
      const k = Math.min(this.streamCount, STREAM_MAX_SLOTS_CLASSIC);
      for (let s = 0; s < k; s++) {
        tx[0] = seq;
        tx[1] = s;
        writeU16(tx, 2, t);
        writeF32(tx, 4, this.streamValue(s));
        this.sendRaw(Cls.STREAM_RSP, 0, 8);
      }
    }
  }

  // ---- FW update -------------------------------------------------------------------------

  private fwAck(status: number, next = this.fwNext): void {
    this.fwSinceAck = 0;
    this.send(encodeFwAck(this.addr, { status, window: FW_WINDOW_DEFAULT, nextOffset: next }));
  }

  private onFwReq(index: number, d: Uint8Array, len: number): void {
    switch (index) {
      case FwReq.BEGIN: {
        if (len < 8) return;
        // Verified image about to start (PROTOCOL §9).
        if (this.fwPhase === 'verifying' || this.fwPhase === 'starting') return this.fwAck(FwStatus.BUSY);
        // A REBOOT answered just before must not start an image this transfer may replace.
        this.fwStartAt = -1;
        const size = readU32(d, 0);
        this.fwNext = 0;
        if (size < CYFW_HEADER_SIZE || size > FW_MAX_SIZE) {
          this.fwPhase = 'idle';
          this.fwBuf = null;
          return this.fwAck(FwStatus.BAD_IMAGE, 0);
        }
        this.fwSize = size;
        this.fwCrc = readU32(d, 4);
        this.fwBuf = new Uint8Array(size);
        this.fwBadCount = 0;
        // Nothing is erased until the header has arrived and proved the image is for us.
        this.fwPhase = 'header';
        this.fwAck(FwStatus.OK, 0);
        return;
      }
      case FwReq.DATA: {
        // PROTOCOL §9: payload + 3 is a whole frame length; padding is never data.
        if (len < 4 || !isValidFdLength(len)) return;
        switch (this.fwPhase) {
          case 'verifying':
          case 'starting':
            return this.fwAck(FwStatus.BUSY);
          case 'erasing':
            return; // the OK after the erase tells the host where to resume
          case 'header':
          case 'receiving':
            break;
          default:
            return this.fwAck(FwStatus.WRONG_STATE);
        }
        const buf = this.fwBuf!;
        const off = readU24(d, 0);
        if (off !== this.fwNext) {
          // One BAD_OFFSET per window of stray frames: the host resumes from next_offset, and
          // frames it already had in flight should not each trigger another reply.
          if (this.fwBadCount === 0) this.fwAck(FwStatus.BAD_OFFSET);
          if (++this.fwBadCount >= FW_WINDOW_DEFAULT) this.fwBadCount = 0;
          return;
        }
        this.fwBadCount = 0;
        // Bytes past `size` are padding of a short final chunk.
        let n = Math.min(len - 3, this.fwSize - off);
        if (this.fwPhase === 'header') {
          // Header bytes only: whatever follows in this frame is sent again after the erase.
          n = Math.min(n, CYFW_HEADER_SIZE - off);
          for (let i = 0; i < n; i++) buf[off + i] = d[3 + i] ?? 0;
          this.fwNext = off + n;
          if (this.fwNext === CYFW_HEADER_SIZE) return this.onFwHeader();
          if (++this.fwSinceAck >= FW_WINDOW_DEFAULT) this.fwAck(FwStatus.OK);
          return;
        }
        if (n <= 0) return;
        for (let i = 0; i < n; i++) buf[off + i] = d[3 + i] ?? 0;
        this.fwNext = off + n;
        if (this.flashWriteFails) {
          this.fwPhase = 'idle';
          return this.fwAck(FwStatus.FLASH_ERROR);
        }
        // A short final window is not acknowledged on its own: END's ACK closes it.
        if (++this.fwSinceAck >= FW_WINDOW_DEFAULT) this.fwAck(FwStatus.OK);
        return;
      }
      case FwReq.END: {
        if (this.fwPhase === 'verifying' || this.fwPhase === 'starting' || this.fwPhase === 'erasing') {
          return this.fwAck(FwStatus.BUSY);
        }
        if (this.fwPhase !== 'receiving' && this.fwPhase !== 'header') return this.fwAck(FwStatus.WRONG_STATE);
        if (this.fwPhase !== 'receiving' || this.fwNext < this.fwSize) return this.fwAck(FwStatus.BAD_OFFSET);
        this.fwPhase = 'verifying';
        this.fwPhaseDoneAt = this.now + FW_VERIFY_MS;
        return;
      }
    }
  }

  /** The first 64 bytes are in: check them before anything is erased (PROTOCOL §9). */
  private onFwHeader(): void {
    const buf = this.fwBuf!;
    if (!this.headerFits(buf.subarray(0, CYFW_HEADER_SIZE), this.fwSize)) {
      // The installed application stays untouched.
      this.fwPhase = 'idle';
      this.fwBuf = null;
      return this.fwAck(FwStatus.BAD_IMAGE);
    }
    // Erasing destroys the application: an interrupted update leaves the board in the bootloader.
    this.appValid = false;
    this.appBroken = false;
    this.fwPhase = 'erasing';
    this.fwPhaseDoneAt = this.now + 60 + Math.ceil(this.fwSize / 2048) * 4;
    this.fwAck(FwStatus.BUSY);
  }

  /** Header for this board (model, hardware revision, CRC) describing a file of exactly `size` bytes. */
  private headerFits(hdr: Uint8Array, size: number): boolean {
    const h = decodeCyfwHeader(hdr);
    if (!h || h.headerVer !== 1 || crc32(hdr, 0, 60) !== h.headerCrc32) return false;
    if (h.model !== this.def.model || this.hwRev < h.hwRevMin || this.hwRev > h.hwRevMax) return false;
    const sig = (readU16(hdr, 22) & 1) !== 0 ? CYFW_SIGNATURE_SIZE : 0;
    return size >= CYFW_HEADER_SIZE + sig && h.payloadSize === size - CYFW_HEADER_SIZE - sig;
  }

  private fwTick(): void {
    if (this.fwStartAt >= 0 && this.now >= this.fwStartAt) {
      this.fwStartAt = -1;
      // Only a just-verified image, or an untouched valid one (REBOOT).
      if (this.fwPhase === 'starting' || (this.fwPhase === 'idle' && this.appValid)) return this.startApp();
    }
    if (this.now < this.fwPhaseDoneAt) return;
    if (this.fwPhase === 'erasing') {
      this.fwPhase = 'receiving';
      this.fwSinceAck = 0;
      this.fwAck(FwStatus.OK); // next_offset = 64: the header is already in
    } else if (this.fwPhase === 'verifying') {
      const buf = this.fwBuf!;
      this.fwBuf = null;
      if (crc32(buf) !== this.fwCrc) {
        this.fwPhase = 'idle';
        return this.fwAck(FwStatus.BAD_CRC);
      }
      const h = decodeCyfwHeader(buf)!;
      const sig = (readU16(buf, 22) & 1) !== 0 ? CYFW_SIGNATURE_SIZE : 0;
      if (crc32(buf, CYFW_HEADER_SIZE, buf.length - sig) !== h.payloadCrc32) {
        this.fwPhase = 'idle';
        return this.fwAck(FwStatus.BAD_IMAGE);
      }
      this.appFw = { major: h.fwMajor, minor: h.fwMinor, patch: h.fwPatch };
      this.gitHash = h.gitHash;
      this.buildDay = h.buildDay;
      this.appValid = true;
      this.fwPhase = 'starting';
      this.fwStartAt = this.now + FW_START_DELAY_MS;
      this.fwAck(FwStatus.OK);
    }
  }

  /** Bootloader jumps to the installed application (no recovery window: it is already running). */
  private startApp(): void {
    this.powerOff();
    this.mode = NodeMode.BOOT;
    this.bootIntoLoader = false;
    this.bootDoneAt = this.now;
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
      case 'brokenApp':
        // Takes effect at the next start-up; a new image (or switching it off) repairs it.
        this.appBroken = on && this.appValid;
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
    if (this.appBroken) out.push('brokenApp');
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
