import { actionByCmd, getModel, paramByKey, statusFrameByIndex } from '../../catalog/catalog';
import { COMMON_COMMANDS, COMMON_FAULTS } from '../../catalog/common';
import type { BitDef, ModelDef, ParamDef } from '../../catalog/schema';
import { decodeStatusFrameInto } from '../../catalog/status';
import { checkParamValue, quantizeParamValue } from '../../catalog/values';
import { f32ToBits, readU16, toHex } from '../../core/bytes';
import {
  Cls,
  Command,
  CommandStatus,
  DeviceState,
  ENTER_BOOTLOADER_INTENT,
  FwRsp,
  InfoPage,
  NAME_BYTES,
  NUM_UNASSIGNED,
  ParamRsp,
  ParamStatus,
  PType,
  StreamRsp,
  SysRsp,
  Timing,
} from '../../core/constants';
import type { Address, CanFrame, TxFrame } from '../../core/frame';
import {
  type EnumRsp,
  type Heartbeat,
  decodeCommandRsp,
  decodeFaultRsp,
  decodeFwAck,
  decodeInfoRsp,
  decodeParamValue,
  encodeCommand,
  encodeFaultReq,
  encodeIdentify,
  encodeInfoReq,
  encodeNameSet,
  encodeParamGet,
  encodeParamSet,
  uid96FromInfoPages,
} from '../../core/messages';
import { decodeName, encodeName } from '../../core/text';
import { Emitter } from '../emitter';
import { CyError } from '../errors';
import { type Accept, RequestTracker } from '../requests';
import type {
  BuildInfo,
  CatalogStatus,
  CommandOptions,
  CommandResult,
  ControlStopReason,
  DeviceCapabilities,
  DeviceEventKind,
  DeviceEvents,
  DeviceFaults,
  DeviceFlags,
  DeviceHandle,
  DriverContext,
  FwVersion,
  ReadAllProgress,
  ReadAllResult,
  ResolvedFault,
  SelfTestResult,
  SignalUpdate,
} from '../types';
import { uid48ToHex } from '../uid';
import { CyCanControl } from './control';
import { CyCanFirmware } from './firmware';
import { CyCanStream } from './stream';

const INFO_RETRY_MS = 5000;
const NO_FAULTS: DeviceFaults = Object.freeze({ active: 0, sticky: 0, warn: 0, list: Object.freeze([]) as readonly ResolvedFault[] });

/** Hooks from a device back into its driver. */
export interface DeviceHost {
  ctx: DriverContext;
  notify(device: CyCanDevice, kind: DeviceEventKind): void;
  reindex(device: CyCanDevice, oldDevType: number, oldNum: number): void;
}

interface SignalUpdateState {
  t: number;
  frame: number;
  keys: readonly string[];
  values: Readonly<Record<string, number>>;
}

/** One CyCAN board, keyed by uid48 for its whole life on the bus. */
export class CyCanDevice implements DeviceHandle {
  readonly driver = 'cycan';
  readonly uid48: string;
  readonly uid48Num: number;
  readonly uid16: number;
  uid96: string | null = null;
  model: number;
  def: ModelDef | undefined;
  devType: number;
  num: number;
  name = '';
  fw: FwVersion | null = null;
  hwRev: number | null = null;
  catalogRev: number | null = null;
  build: BuildInfo | null = null;
  state: number = DeviceState.BOOT;
  flags: DeviceFlags = { unsaved: false, enabled: false, warning: false, identify: false };
  faults: DeviceFaults = NO_FAULTS;
  online = true;
  lastSeen: number;
  conflict = false;
  enumBootloader = false;
  infoLoaded = false;
  capabilities: DeviceCapabilities;

  readonly control: CyCanControl;
  readonly stream: CyCanStream;
  readonly firmware: CyCanFirmware;
  /** Request/response tracking; also used by the firmware updater. */
  readonly requests: RequestTracker;

  private readonly events = new Emitter<DeviceEvents>();
  private readonly cache = new Map<string, number>();
  private signalValues: Record<string, number> = {};
  private statusKeys = new Map<number, readonly string[]>();
  private readonly signalUpdate: SignalUpdateState = { t: 0, frame: 0, keys: [], values: {} };
  private readonly signalListeners = new Set<(u: SignalUpdate) => void>();
  private lastBeat: number;
  private lostTimer: unknown = undefined;
  private infoLoading = false;
  private infoRetryAt = 0;
  private faultReadPending = false;
  private removed = false;
  /** Streams are rebuilt once the board that restarted reports a running state again. */
  private streamRestorePending = false;

  constructor(
    private readonly host: DeviceHost,
    rsp: EnumRsp,
    devType: number,
    now: number,
  ) {
    this.uid48Num = rsp.uid48;
    this.uid48 = uid48ToHex(rsp.uid48);
    this.uid16 = rsp.uid48 % 0x10000;
    this.devType = devType;
    this.num = rsp.num;
    this.conflict = rsp.conflict;
    this.enumBootloader = rsp.bootloader;
    this.model = rsp.model;
    this.def = getModel(rsp.model);
    this.capabilities = this.computeCapabilities();
    this.lastSeen = this.lastBeat = now;
    this.requests = new RequestTracker(
      host.ctx.scheduler,
      (f) => this.host.ctx.send(f),
      () => this.host.ctx.countRequestTimeout(),
    );
    this.control = new CyCanControl(this);
    this.stream = new CyCanStream(this);
    this.firmware = new CyCanFirmware(this);
    this.rebuildSignals();
    if (rsp.bootloader) this.state = DeviceState.BOOTLOADER;
    this.armLostTimer();
  }

  // ---------------------------------------------------------------------------------------
  // Identity

  get address(): Address {
    return { devType: this.devType, num: this.num };
  }

  get unassigned(): boolean {
    return this.num === NUM_UNASSIGNED || this.num === 0;
  }

  get bootloader(): boolean {
    return this.state === DeviceState.BOOTLOADER || this.enumBootloader;
  }

  get resolved(): boolean {
    return !this.unassigned && !this.conflict;
  }

  get catalogStatus(): CatalogStatus {
    if (!this.def) return 'unknownModel';
    if (this.catalogRev !== null && this.catalogRev > this.def.catalogRev) return 'newerCatalog';
    return 'ok';
  }

  get ctx(): DriverContext {
    return this.host.ctx;
  }

  on<K extends keyof DeviceEvents>(event: K, cb: (payload: DeviceEvents[K]) => void): () => void {
    return this.events.on(event, cb);
  }

  send(frame: TxFrame): void {
    this.host.ctx.send(frame);
  }

  // ---------------------------------------------------------------------------------------
  // Driver-facing updates

  /** ENUM_RSP from this board (discovery round or ASSIGN_ID confirmation). */
  applyEnum(rsp: EnumRsp, devType: number, now: number): void {
    let changed = this.touch(now, true);
    let renumbered = false;
    if (rsp.num !== this.num || devType !== this.devType) {
      const old: Address = { devType: this.devType, num: this.num };
      this.num = rsp.num;
      this.devType = devType;
      this.host.reindex(this, old.devType, old.num);
      // The old address may now belong to another board: never keep driving it (PROTOCOL §7).
      // The neutral goes to the old address, where this board's last commands went.
      this.control.halt('renumbered', old);
      renumbered = true;
      changed = true;
    }
    if (rsp.conflict !== this.conflict || rsp.bootloader !== this.enumBootloader) {
      this.conflict = rsp.conflict;
      this.enumBootloader = rsp.bootloader;
      changed = true;
    }
    if (this.conflict || this.unassigned) this.control.halt('unresolved');
    // A renumbered board stops streaming (PROTOCOL §3.3); lay the stream out again at the new address.
    else if (renumbered) this.stream.deviceBack();
    if (rsp.model !== this.model) {
      this.setModel(rsp.model);
      changed = true;
    }
    if (changed) this.changed();
    this.maybeLoadInfo(now);
  }

  applyHeartbeat(hb: Heartbeat, now: number): void {
    let changed = this.touch(now, true);
    const prevState = this.state;
    const f = this.flags;
    this.superviseControl(hb, f.enabled);
    if (hb.state === DeviceState.BOOT && prevState !== DeviceState.BOOT) this.restarted();
    else if (hb.state === DeviceState.ESTOP && prevState !== DeviceState.ESTOP) {
      this.requests.failInProgress(new CyError('ABORTED', 'board is in emergency stop', { reason: 'estop' }));
    }
    if (
      hb.state !== this.state ||
      hb.unsaved !== f.unsaved ||
      hb.enabled !== f.enabled ||
      hb.warning !== f.warning ||
      hb.identify !== f.identify
    ) {
      this.state = hb.state;
      this.flags = { unsaved: hb.unsaved, enabled: hb.enabled, warning: hb.warning, identify: hb.identify };
      changed = true;
    }
    if (hb.state !== DeviceState.BOOTLOADER && this.enumBootloader) {
      this.enumBootloader = false;
      changed = true;
    }
    if (!this.fw || this.fw.major !== hb.fwMajor || this.fw.minor !== hb.fwMinor || this.fw.patch !== hb.fwPatch) {
      this.fw = { major: hb.fwMajor, minor: hb.fwMinor, patch: hb.fwPatch };
      changed = true;
    }
    // The heartbeat only carries active faults; fetch sticky/warn bits when the picture changes.
    const faultsMoved = hb.warning !== f.warning || hb.fault !== this.faults.active;
    if (hb.fault !== this.faults.active) {
      this.faults = this.resolveFaults(hb.fault, this.faults.sticky, this.faults.warn);
      changed = true;
    }
    if (prevState === DeviceState.BOOTLOADER && hb.state !== DeviceState.BOOTLOADER) {
      // Left the bootloader: firmware (and possibly the catalog revision) changed.
      this.invalidateInfo();
    }
    if (this.streamRestorePending && hb.state !== DeviceState.BOOT && hb.state !== DeviceState.BOOTLOADER) {
      this.streamRestorePending = false;
      this.stream.deviceBack();
    }
    if (changed) this.changed();
    if (faultsMoved) this.refreshFaults();
    this.maybeLoadInfo(now);
  }

  /** PROTOCOL §7: the host stops driving a board that is no longer driven or able to be. */
  private superviseControl(hb: Heartbeat, wasEnabled: boolean): void {
    if (!this.control.active) return;
    let reason: ControlStopReason | null = null;
    if (hb.state === DeviceState.BOOT) reason = 'boardReset';
    else if (hb.state === DeviceState.ESTOP) reason = 'boardEstop';
    else if (hb.state === DeviceState.FAULT) reason = 'boardFault';
    else if (hb.state === DeviceState.BOOTLOADER) reason = 'bootloader';
    else if (wasEnabled && !hb.enabled && this.control.driving) reason = 'disabled';
    if (reason) this.control.halt(reason);
  }

  /**
   * The board restarted (heartbeat `state = BOOT`, PROTOCOL §4.1): RAM parameters, INFO and
   * stream slots are gone and long commands will never finish. Streams are rebuilt once the
   * board runs again.
   */
  private restarted(): void {
    this.invalidateInfo();
    this.requests.failInProgress(new CyError('ABORTED', 'board restarted', { reason: 'board_reset' }));
    if (this.stream.active) this.streamRestorePending = true;
  }

  emitControlStopped(reason: ControlStopReason): void {
    this.events.emit('controlStopped', { reason });
  }

  /**
   * True while this host drives the board, or the board reports ENABLED and this host did not
   * stop a session of its own within the last heartbeat period (the flag lags behind).
   */
  get driven(): boolean {
    if (this.control.active) return true;
    const sinceStop = this.host.ctx.scheduler.now() - this.control.endedAt;
    return this.online && this.flags.enabled && sinceStop > Timing.HEARTBEAT_MS + Timing.HEARTBEAT_PHASE_MAX_MS;
  }

  handleFrame(frame: CanFrame, cls: number, index: number): void {
    this.lastSeen = frame.timestamp;
    const d = frame.data;
    switch (cls) {
      case Cls.STATUS:
        this.onStatus(index, d, frame.timestamp);
        return;
      case Cls.STREAM_RSP:
        if (index === StreamRsp.DATA) this.stream.handleData(d, frame.timestamp);
        return;
      case Cls.PARAM_RSP:
        if (index === ParamRsp.VALUE && d.length >= 2) this.requests.deliver(`p:${readU16(d, 0)}`, d);
        return;
      case Cls.SYS_RSP:
        if (index === SysRsp.INFO_RSP && d.length >= 1) this.requests.deliver(`i:${d[0] ?? 0}`, d);
        else if (index === SysRsp.COMMAND_RSP && d.length >= 1) this.requests.deliver(`c:${d[0] ?? 0}`, d);
        else if (index === SysRsp.FAULT_RSP) this.requests.deliver('f', d);
        return;
      case Cls.FW_RSP:
        if (index === FwRsp.ACK) {
          const ack = decodeFwAck(d);
          if (ack) this.firmware.handleAck(ack);
        }
        return;
    }
  }

  /** Returns true when the board came back from being lost. */
  private touch(now: number, beat: boolean): boolean {
    this.lastSeen = now;
    if (beat) this.lastBeat = now;
    if (this.online) return false;
    this.online = true;
    this.invalidateInfo();
    this.armLostTimer();
    this.stream.deviceBack();
    return true;
  }

  private armLostTimer(): void {
    const s = this.host.ctx.scheduler;
    if (this.lostTimer !== undefined) s.clearTimeout(this.lostTimer);
    const due = this.lastBeat + Timing.LOST_AFTER_MS - s.now();
    // Heartbeats only refresh a timestamp; the timer re-arms itself lazily so a 2 Hz
    // heartbeat does not cost a timer reschedule each time.
    this.lostTimer = s.setTimeout(() => {
      this.lostTimer = undefined;
      if (!this.online || this.removed) return;
      if (s.now() - this.lastBeat >= Timing.LOST_AFTER_MS) this.markLost();
      else this.armLostTimer();
    }, Math.max(1, due));
  }

  markLost(): void {
    if (!this.online) return;
    this.online = false;
    this.control.halt('lost');
    this.host.notify(this, 'deviceLost');
    this.events.emit('changed', this);
  }

  /** Transport down: offline without event storms of retries. */
  transportDown(error: CyError): void {
    this.requests.failAll(error);
    this.control.halt('disconnected');
    this.stream.halt();
    this.firmware.abortAll(error);
    this.cancelLostTimer();
    this.markLost();
  }

  /** Driver removes the handle for good. */
  dispose(error: CyError): void {
    this.removed = true;
    this.requests.failAll(error);
    this.control.halt('disconnected');
    this.stream.halt();
    this.firmware.abortAll(error);
    this.cancelLostTimer();
    this.online = false;
    this.signalListeners.clear();
  }

  /** Called after the transport is open again: restart lost supervision for known boards. */
  resume(): void {
    if (this.removed) return;
    this.lastBeat = this.host.ctx.scheduler.now();
    if (this.online) this.armLostTimer();
  }

  private cancelLostTimer(): void {
    if (this.lostTimer !== undefined) this.host.ctx.scheduler.clearTimeout(this.lostTimer);
    this.lostTimer = undefined;
  }

  private changed(): void {
    this.host.notify(this, 'deviceChanged');
    this.events.emit('changed', this);
  }

  private setModel(model: number): void {
    this.model = model;
    this.def = getModel(model);
    this.capabilities = this.computeCapabilities();
    this.rebuildSignals();
    this.cache.clear();
  }

  private computeCapabilities(): DeviceCapabilities {
    const d = this.def;
    return {
      params: d !== undefined,
      signals: d !== undefined && d.signals.length > 0,
      stream: d !== undefined && d.signals.length > 0,
      control: d !== undefined && d.controls.length > 0,
      commands: true,
      faults: true,
      firmware: true,
      rename: true,
      identify: true,
      assignId: true,
    };
  }

  // ---------------------------------------------------------------------------------------
  // INFO pages

  private invalidateInfo(): void {
    this.infoLoaded = false;
    this.infoRetryAt = 0;
    if (this.cache.size > 0) {
      this.cache.clear();
      this.events.emit('paramsInvalidated', this);
    }
  }

  maybeLoadInfo(now: number): void {
    if (this.infoLoaded || this.infoLoading || !this.online || !this.resolved || this.bootloader) return;
    if (now < this.infoRetryAt || !this.host.ctx.isOpen()) return;
    this.infoLoading = true;
    this.loadInfo().then(
      () => {
        this.infoLoading = false;
        this.infoLoaded = true;
        this.changed();
      },
      () => {
        this.infoLoading = false;
        this.infoRetryAt = this.host.ctx.scheduler.now() + INFO_RETRY_MS;
      },
    );
  }

  private async loadInfo(): Promise<void> {
    const p0 = decodeInfoRsp(await this.infoPage(InfoPage.DEVICE));
    if (p0?.section === 'device') {
      this.hwRev = p0.hwRev;
      this.catalogRev = p0.catalogRev;
      if (p0.model !== this.model) this.setModel(p0.model);
    }
    if (this.uid96 === null) {
      const p1 = await this.infoPage(InfoPage.UID_LO);
      const p2 = await this.infoPage(InfoPage.UID_HI);
      this.uid96 = toHex(uid96FromInfoPages(p1.subarray(1, 8), p2.subarray(1, 8)));
    }
    const p3 = decodeInfoRsp(await this.infoPage(InfoPage.BUILD));
    if (p3?.section === 'build') this.build = { gitHash: p3.gitHash, buildDay: p3.buildDay, dirty: p3.dirty };
    const name = new Uint8Array(NAME_BYTES);
    for (let i = 0; i < 3; i++) name.set((await this.infoPage(InfoPage.NAME_0 + i)).subarray(1, 8), 7 * i);
    this.name = decodeName(name);
  }

  private infoPage(page: number): Promise<Uint8Array> {
    return this.requests.request<Uint8Array>({
      key: `i:${page}`,
      what: `INFO page ${page}`,
      frame: () => encodeInfoReq(this.address, { page }),
      accept: (d) => (d.length >= 8 ? { kind: 'done', value: d } : null),
    });
  }

  // ---------------------------------------------------------------------------------------
  // Parameters

  get params(): ReadonlyMap<string, number> {
    return this.cache;
  }

  cachedParam(key: string): number | undefined {
    return this.cache.get(key);
  }

  private paramDef(key: string): ParamDef {
    this.require('params');
    const p = this.def ? paramByKey(this.def, key) : undefined;
    if (!p) throw new CyError('INVALID', `unknown parameter ${key}`, { reason: 'unknown_param' });
    return p;
  }

  getParam(key: string): Promise<number> {
    return this.guard(() => {
      const p = this.paramDef(key);
      this.requireResolved();
      return this.paramRequest(p, encodeParamGetFor(this, p), false);
    });
  }

  setParam(key: string, value: number): Promise<number> {
    return this.guard(() => {
      const p = this.paramDef(key);
      const check = checkParamValue(p, value);
      if (check !== 'ok') throw new CyError('INVALID', `${key}: ${check}`, { reason: check });
      this.requireResolved();
      const expect = quantizeParamValue(p, value);
      return this.paramRequest(p, () => encodeParamSet(this.address, { pid: p.pid, ptype: p.ptype, value }), true, expect);
    });
  }

  /** `expect`: for a SET, the value an accepting board must report; any other OK answer is a stale one. */
  private paramRequest(p: ParamDef, frame: () => TxFrame, isSet: boolean, expect?: number): Promise<number> {
    return this.requests.request<number>({
      key: `p:${p.pid}`,
      what: `${isSet ? 'SET' : 'GET'} ${p.key}`,
      frame,
      accept: (d): Accept<number> => {
        const v = decodeParamValue(d);
        if (!v) return null;
        if (v.status === ParamStatus.OK) {
          if (expect !== undefined && v.value !== expect) return null;
          this.storeParam(p.key, v.value);
          return { kind: 'done', value: v.value };
        }
        // A rejected SET still reports the value the board keeps.
        if (isSet && v.status !== ParamStatus.UNKNOWN_PARAM && v.status !== ParamStatus.TYPE_MISMATCH) {
          this.storeParam(p.key, v.value);
        }
        return {
          kind: 'fail',
          error: new CyError('REJECTED', `${p.key}: board status ${v.status}`, { status: v.status, statusKind: 'param' }),
        };
      },
    });
  }

  private storeParam(key: string, value: number): void {
    if (this.cache.get(key) === value) return;
    this.cache.set(key, value);
    this.events.emit('paramChanged', { key, value });
  }

  async readAllParams(opts: { onProgress?: (p: ReadAllProgress) => void; window?: number } = {}): Promise<ReadAllResult> {
    this.require('params');
    this.requireResolved();
    const list = this.def?.params ?? [];
    const values: Record<string, number> = {};
    const failed: Array<{ key: string; error: Error }> = [];
    let next = 0;
    let done = 0;
    const total = list.length;
    // A small window of outstanding GETs keeps the bus busy without flooding a board's RX queue.
    const worker = async (): Promise<void> => {
      for (;;) {
        const p = list[next++];
        if (!p) return;
        try {
          values[p.key] = await this.paramRequest(p, encodeParamGetFor(this, p), false);
        } catch (e) {
          if (e instanceof CyError && e.code === 'DISCONNECTED') throw e;
          failed.push({ key: p.key, error: e instanceof Error ? e : new Error(String(e)) });
        }
        done++;
        opts.onProgress?.({ done, total });
      }
    };
    const n = Math.max(1, Math.min(opts.window ?? 8, total));
    await Promise.all(Array.from({ length: n }, worker));
    return { values, failed };
  }

  async save(): Promise<void> {
    await this.command(Command.SAVE_PARAMS);
  }

  async loadDefaults(): Promise<void> {
    await this.command(Command.LOAD_DEFAULTS);
    this.cache.clear();
    this.events.emit('paramsInvalidated', this);
  }

  async loadSaved(): Promise<void> {
    await this.command(Command.LOAD_SAVED);
    this.cache.clear();
    this.events.emit('paramsInvalidated', this);
  }

  async rename(name: string): Promise<void> {
    this.requireResolved();
    const bytes = encodeName(name);
    for (let page = 0; page < 3; page++) {
      const chunk = bytes.slice(7 * page, 7 * page + 7);
      await this.requests.request<Uint8Array>({
        key: `i:${InfoPage.NAME_0 + page}`,
        what: 'NAME_SET',
        frame: () => encodeNameSet(this.address, { page, bytes: chunk }),
        accept: (d) => (d.length >= 8 ? { kind: 'done', value: d } : null),
      });
    }
    const stored = decodeName(bytes);
    if (stored !== this.name) {
      this.name = stored;
      this.changed();
    }
  }

  // ---------------------------------------------------------------------------------------
  // Signals

  get signals(): Readonly<Record<string, number>> {
    return this.signalValues;
  }

  getSignal(key: string): number {
    return this.signalValues[key] ?? NaN;
  }

  onSignals(cb: (u: SignalUpdate) => void): () => void {
    this.signalListeners.add(cb);
    return () => {
      this.signalListeners.delete(cb);
    };
  }

  private rebuildSignals(): void {
    const values: Record<string, number> = {};
    this.statusKeys = new Map();
    if (this.def) {
      for (const s of this.def.signals) values[s.key] = NaN;
      for (const f of this.def.statusFrames) this.statusKeys.set(f.index, f.fields.map((x) => x.signal));
    }
    this.signalValues = values;
    this.signalUpdate.values = values;
  }

  private onStatus(index: number, data: Uint8Array, t: number): void {
    const def = this.def;
    if (!def) return;
    const frameDef = statusFrameByIndex(def, index);
    if (!frameDef || !decodeStatusFrameInto(frameDef, data, this.signalValues)) return;
    if (this.signalListeners.size === 0) return;
    const u = this.signalUpdate;
    u.t = t;
    u.frame = index;
    u.keys = this.statusKeys.get(index) ?? [];
    for (const cb of this.signalListeners) cb(u);
  }

  // ---------------------------------------------------------------------------------------
  // Commands

  command(keyOrCmd: string | number, arg = 0, opts: CommandOptions = {}): Promise<CommandResult> {
    return this.guard(() => {
      this.requireResolved();
      const { cmd, wire } = this.resolveCommand(keyOrCmd, arg);
      return this.commandRaw(cmd, wire, opts);
    });
  }

  abortAction(): void {
    if (!this.capabilities.control || !this.online || this.unassigned) return;
    this.control.neutralAll();
  }

  /** Sends a COMMAND without the resolved-state check; used by the firmware updater. */
  commandRaw(cmd: number, wireArg: number, opts: CommandOptions & { attempts?: number } = {}): Promise<CommandResult> {
    return this.requests.request<CommandResult>({
      key: `c:${cmd}`,
      what: `COMMAND ${cmd}`,
      frame: () => encodeCommand(this.address, { cmd, arg: wireArg }),
      attempts: opts.attempts,
      finalTimeoutMs: opts.finalTimeoutMs,
      onProgress: opts.onProgress,
      accept: (d): Accept<CommandResult> => {
        const r = decodeCommandRsp(d);
        if (!r) return null;
        if (r.status === CommandStatus.IN_PROGRESS) return { kind: 'progress' };
        if (r.status === CommandStatus.OK) return { kind: 'done', value: { cmd: r.cmd, status: r.status, result: r.result } };
        return {
          kind: 'fail',
          error: new CyError('REJECTED', `command ${cmd}: board status ${r.status}`, { status: r.status, statusKind: 'command' }),
        };
      },
    });
  }

  private resolveCommand(keyOrCmd: string | number, arg: number): { cmd: number; wire: number } {
    let cmd: number | undefined;
    if (typeof keyOrCmd === 'number') cmd = keyOrCmd;
    else {
      cmd = COMMON_COMMANDS.find((c) => c.key === keyOrCmd)?.cmd ?? this.def?.actions.find((a) => a.key === keyOrCmd)?.cmd;
    }
    if (cmd === undefined || !Number.isInteger(cmd) || cmd < 1 || cmd > 0xff) {
      throw new CyError('INVALID', `unknown command ${String(keyOrCmd)}`, { reason: 'unknown_command' });
    }
    // Asking for ENTER_BOOTLOADER by name is the intent; the board wants it spelled out (PROTOCOL §4.5).
    if (cmd === Command.ENTER_BOOTLOADER && arg === 0) return { cmd, wire: this.enterBootloaderArg };
    const action = this.def ? actionByCmd(this.def, cmd) : undefined;
    if (!action?.arg) {
      if (!Number.isFinite(arg)) throw new CyError('INVALID', 'command argument', { reason: 'not_number' });
      return { cmd, wire: Math.round(arg) >>> 0 };
    }
    const a = action.arg;
    if (!Number.isFinite(arg) || arg < a.min || arg > a.max) {
      throw new CyError('INVALID', `${action.key}: argument out of range`, { reason: 'out_of_range' });
    }
    if (a.ptype === PType.F32) return { cmd, wire: f32ToBits(arg) };
    return { cmd, wire: Math.round(arg) >>> 0 };
  }

  /** `ENTER_BOOTLOADER` intent argument for this board. */
  get enterBootloaderArg(): number {
    return (ENTER_BOOTLOADER_INTENT | this.uid16) >>> 0;
  }

  identify(seconds: number): Promise<void> {
    return this.guard(async () => {
      this.require('identify');
      // Unresolved boards only accept the UID form; the bus offers that as identifyByUid.
      this.requireResolved();
      this.send(encodeIdentify(this.address, { seconds: Math.max(0, Math.min(255, Math.round(seconds))) }));
    });
  }

  async reboot(): Promise<void> {
    await this.command(Command.REBOOT);
    // RAM is reloaded from flash (unsaved values are gone) and the board is silent while it
    // boots: drop the cache and re-read INFO when its heartbeat returns.
    this.invalidateInfo();
    this.changed();
  }

  async clearFaults(): Promise<void> {
    await this.command(Command.CLEAR_FAULTS);
    this.faults = this.resolveFaults(this.faults.active, 0, this.faults.warn);
    this.changed();
  }

  async clearEstop(): Promise<void> {
    await this.command(Command.CLEAR_ESTOP);
  }

  async selfTest(opts: CommandOptions = {}): Promise<SelfTestResult> {
    const r = await this.command(Command.SELF_TEST, 0, opts);
    const bits: BitDef[] = this.def?.selfTestBits ?? [];
    const failed: BitDef[] = [];
    for (let b = 0; b < 32; b++) {
      if ((r.result >>> b) & 1) failed.push(bits.find((x) => x.bit === b) ?? unknownBit(b));
    }
    return { passed: r.result === 0, mask: r.result >>> 0, failed };
  }

  readFaults(): Promise<DeviceFaults> {
    return this.guard(() => {
      this.requireResolved();
      return this.requests.request<DeviceFaults>({
        key: 'f',
        what: 'FAULT_REQ',
        frame: () => encodeFaultReq(this.address),
        accept: (d) => {
          const r = decodeFaultRsp(d);
          if (!r) return null;
          this.faults = this.resolveFaults(r.active, r.sticky, r.warn);
          this.changed();
          return { kind: 'done', value: this.faults };
        },
      });
    });
  }

  private refreshFaults(): void {
    if (this.faultReadPending || !this.resolved) return;
    this.faultReadPending = true;
    this.readFaults().then(
      () => (this.faultReadPending = false),
      () => (this.faultReadPending = false),
    );
  }

  private resolveFaults(active: number, sticky: number, warn: number): DeviceFaults {
    const list: ResolvedFault[] = [];
    const add = (mask: number, kind: ResolvedFault['kind']): void => {
      for (let b = 0; b < 16; b++) {
        if (!((mask >> b) & 1)) continue;
        const def = COMMON_FAULTS.find((f) => f.bit === b) ?? this.def?.faults.find((f) => f.bit === b) ?? unknownBit(b);
        list.push({ bit: b, key: def.key, label: def.label, kind });
      }
    };
    add(active, 'active');
    add(sticky, 'sticky');
    add(warn, 'warn');
    return { active, sticky, warn, list };
  }

  // ---------------------------------------------------------------------------------------
  // Guards

  require(cap: keyof DeviceCapabilities): void {
    if (!this.capabilities[cap]) {
      throw new CyError('NOT_SUPPORTED', `${cap} not supported by this device`, { reason: cap });
    }
  }

  requireResolved(): void {
    if (this.removed || !this.host.ctx.isOpen()) throw new CyError('DISCONNECTED', 'bus is not running');
    if (!this.resolved) throw new CyError('UNRESOLVED', `board ${this.uid48} has no valid number`);
  }

  /** Turns synchronous validation throws into rejected promises. */
  private guard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return fn();
    } catch (e) {
      return Promise.reject(e);
    }
  }
}

function encodeParamGetFor(dev: CyCanDevice, p: ParamDef): () => TxFrame {
  return () => encodeParamGet(dev.address, { pid: p.pid });
}

function unknownBit(bit: number): BitDef {
  return { bit, key: `bit${bit}`, label: { tr: `Bit ${bit}`, en: `Bit ${bit}` } };
}
