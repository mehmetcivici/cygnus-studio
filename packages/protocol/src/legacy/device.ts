import type { ModelDef } from '../catalog/schema';
import { DeviceState } from '../core/constants';
import type { TxFrame } from '../core/frame';
import { Emitter } from '../host/emitter';
import { CyError } from '../host/errors';
import type {
  BuildInfo,
  CatalogStatus,
  CommandOptions,
  CommandResult,
  ControlLoop,
  DeviceCapabilities,
  DeviceControl,
  DeviceEventKind,
  DeviceEvents,
  DeviceFaults,
  DeviceFirmware,
  DeviceFlags,
  DeviceHandle,
  DeviceStream,
  DriverContext,
  FirmwareResult,
  FwVersion,
  ReadAllResult,
  SelfTestResult,
  SignalUpdate,
  StreamSubscription,
} from '../host/types';
import { CYNCODER_V3_DEF, CYNCODER_V3_MODEL, V3_ACTION_BASE, V3Signal } from './model';
import {
  type V3CommandAck,
  type V3CommandIndex,
  type V3MagnetHealth,
  type V3PositionVelocity,
  V3_ACK_REASONS,
  V3_FIRST_ACK_VERSION,
  V3_TICKS_PER_REV,
  V3Ack,
  V3Command,
  V3Health,
  encodeTargetedCommand,
  uidToHex,
} from './protocol';

const NO_FAULTS: DeviceFaults = Object.freeze({ active: 0, sticky: 0, warn: 0, list: Object.freeze([]) });
const POSITION_KEYS: readonly string[] = [V3Signal.POSITION, V3Signal.POSITION_DEG, V3Signal.VELOCITY, V3Signal.VELOCITY_DPS];
const HEALTH_KEYS: readonly string[] = [
  V3Signal.MAGNET_HEALTH,
  V3Signal.MAGNET_AGC,
  V3Signal.MAGNET_FIELD,
  V3Signal.ABS_TICKS,
  V3Signal.ABS_POSITION,
  V3Signal.PROTOCOL_VERSION,
  V3Signal.BUS_OFF_COUNT,
];
const HEALTH_ONLY: readonly string[] = [V3Signal.MAGNET_HEALTH];

/** Timings of the legacy driver (all in ms). */
export interface LegacyTimings {
  /** No frame from the board for this long: it is lost. */
  lostAfterMs: number;
  /** No position frame for this long: readings are stale and magnet health becomes unknown. */
  telemetryTimeoutMs: number;
  /** How long to wait for a COMMAND_ACK. */
  ackTimeoutMs: number;
}

/** Hooks from a device back into its driver. */
export interface LegacyHost {
  readonly ctx: DriverContext;
  readonly timings: LegacyTimings;
  nextSequence(): number;
  notify(device: CyncoderV3Device, kind: DeviceEventKind): void;
  /** The board's CAN number differs from what the driver indexed it under. */
  reindex(device: CyncoderV3Device, oldNum: number): void;
  /** Re-evaluates the shared-number conflict flags of every board at `num`. */
  recomputeConflicts(num: number): void;
}

/** Outcome of a v3 command: `confirmed` is false for firmware older than v3, which sends no ACK. */
export interface LegacyCommandResult extends CommandResult {
  confirmed: boolean;
}

interface PendingCommand {
  index: V3CommandIndex;
  sequence: number;
  resolve: (r: LegacyCommandResult) => void;
  reject: (e: CyError) => void;
  timer: unknown;
}

function unsupported(cap: string): CyError {
  return new CyError('NOT_SUPPORTED', `${cap} is not supported by the legacy Cyncoder v3 protocol`, { reason: cap });
}

const rejectUnsupported = <T>(cap: string): Promise<T> => Promise.reject(unsupported(cap));

/**
 * One legacy Cyncoder board. Identity is the 32-bit UID from the 2 Hz identity frame (several
 * boards may share a CAN number); the UID is shown as a zero-padded `uid48`.
 */
export class CyncoderV3Device implements DeviceHandle {
  readonly driver = 'cyncoder-v3';
  readonly uid48: string;
  readonly uid32: number;
  readonly uid96 = null;
  readonly model = CYNCODER_V3_MODEL;
  readonly def: ModelDef = CYNCODER_V3_DEF;
  readonly devType = CYNCODER_V3_DEF.devType;
  readonly name = '';
  readonly fw: FwVersion | null = null;
  readonly hwRev = null;
  readonly catalogRev = null;
  readonly build: BuildInfo | null = null;
  readonly flags: DeviceFlags = Object.freeze({ unsaved: false, enabled: false, warning: false, identify: false });
  readonly faults: DeviceFaults = NO_FAULTS;
  readonly unassigned = false;
  readonly bootloader = false;
  readonly infoLoaded = true;
  readonly params: ReadonlyMap<string, number> = new Map();
  readonly capabilities: Readonly<DeviceCapabilities> = Object.freeze({
    params: false,
    signals: true,
    stream: false,
    control: false,
    commands: true,
    faults: false,
    firmware: false,
    rename: false,
    identify: true,
    assignId: false,
  });

  num: number;
  state: number = DeviceState.BOOT;
  online = true;
  lastSeen: number;
  conflict = false;
  /** Protocol version from the health frame extension: null until a health frame was seen, 0 before v2. */
  protocolVersion: number | null = null;

  readonly control: DeviceControl = {
    active: false,
    periodMs: 0,
    set: (): void => {
      throw unsupported('control');
    },
    start: (): ControlLoop => {
      throw unsupported('control');
    },
    send: (): void => {
      throw unsupported('control');
    },
    // Nothing is ever driven, so stopping is a harmless no-op (the bus calls it on E-stop).
    stop: (): void => {},
  };
  readonly stream: DeviceStream = {
    active: false,
    slotsUsed: 0,
    open: (): StreamSubscription => {
      throw unsupported('stream');
    },
  };
  readonly firmware: DeviceFirmware = {
    busy: false,
    update: (): Promise<FirmwareResult> => rejectUnsupported('firmware'),
  };

  private readonly events = new Emitter<DeviceEvents>();
  private readonly signalValues: Record<string, number> = {};
  private readonly signalListeners = new Set<(u: SignalUpdate) => void>();
  private readonly signalUpdate = { t: 0, frame: 0, keys: POSITION_KEYS, values: this.signalValues };
  private lastAlive: number;
  private lastTelemetry = -1;
  private stale = true;
  private timer: unknown = undefined;
  private timerDue = 0;
  private pending: PendingCommand | null = null;
  private removed = false;
  private running = true;

  constructor(
    private readonly host: LegacyHost,
    uid32: number,
    num: number,
    now: number,
  ) {
    this.uid32 = uid32;
    this.uid48 = uidToHex(uid32).padStart(12, '0');
    this.num = num;
    this.lastSeen = this.lastAlive = now;
    for (const s of CYNCODER_V3_DEF.signals) this.signalValues[s.key] = NaN;
    this.arm();
  }

  get uidHex(): string {
    return uidToHex(this.uid32);
  }

  get catalogStatus(): CatalogStatus {
    return 'ok';
  }

  on<K extends keyof DeviceEvents>(event: K, cb: (payload: DeviceEvents[K]) => void): () => void {
    return this.events.on(event, cb);
  }

  // ---------------------------------------------------------------------------------------
  // Driver-facing updates

  /** Any frame attributable to this board (identity, telemetry, ACK). */
  touch(now: number): void {
    this.lastSeen = this.lastAlive = now;
    if (!this.online) {
      this.online = true;
      this.host.recomputeConflicts(this.num);
      this.refreshState();
      this.changed();
    }
    this.arm();
  }

  /** The identity frame carried a different CAN number than before. */
  applyNum(num: number): void {
    if (num === this.num) return;
    const old = this.num;
    this.num = num;
    this.host.reindex(this, old);
    this.changed();
  }

  setConflict(conflict: boolean): void {
    if (conflict === this.conflict) return;
    this.conflict = conflict;
    if (conflict) {
      // Telemetry of a shared number cannot be attributed to one board: show nothing rather than a neighbour's value.
      for (const k of POSITION_KEYS) this.signalValues[k] = NaN;
      for (const k of HEALTH_KEYS) this.signalValues[k] = NaN;
      this.lastTelemetry = -1;
      this.stale = true;
      this.protocolVersion = null;
      this.refreshState();
    }
    this.changed();
  }

  applyPosition(v: V3PositionVelocity, t: number): void {
    this.touch(t);
    const s = this.signalValues;
    s[V3Signal.POSITION] = v.positionDeg / 360;
    s[V3Signal.POSITION_DEG] = v.positionDeg;
    s[V3Signal.VELOCITY] = v.velocityDps / 6;
    s[V3Signal.VELOCITY_DPS] = v.velocityDps;
    this.markFresh(t);
    this.emitSignals(t, 0, POSITION_KEYS);
  }

  applyHealth(h: V3MagnetHealth, t: number): void {
    this.touch(t);
    const s = this.signalValues;
    s[V3Signal.MAGNET_HEALTH] = h.health;
    s[V3Signal.MAGNET_AGC] = h.agc;
    s[V3Signal.MAGNET_FIELD] = h.magnitude;
    s[V3Signal.ABS_TICKS] = h.ext ? h.ext.absTicks : NaN;
    s[V3Signal.ABS_POSITION] = h.ext ? h.ext.absTicks / V3_TICKS_PER_REV : NaN;
    s[V3Signal.PROTOCOL_VERSION] = h.ext ? h.ext.version : 0;
    s[V3Signal.BUS_OFF_COUNT] = h.ext ? h.ext.busOffCount : NaN;
    this.protocolVersion = h.ext ? h.ext.version : 0;
    this.markFresh(t);
    this.emitSignals(t, 1, HEALTH_KEYS);
    if (this.pending && this.protocolVersion < V3_FIRST_ACK_VERSION) this.settleUnconfirmed();
  }

  applyAck(ack: V3CommandAck, t: number): void {
    this.touch(t);
    const p = this.pending;
    if (!p || ack.commandIndex !== p.index || ack.sequence !== p.sequence) return;
    this.clearPending();
    if (ack.result === V3Ack.OK) {
      p.resolve({ cmd: V3_ACTION_BASE | p.index, status: 0, result: 0, confirmed: true });
      return;
    }
    const reason = V3_ACK_REASONS[ack.result] ?? 'unknown_result';
    p.reject(new CyError('REJECTED', `command ${p.index}: board result ${ack.result} (${reason})`, { status: ack.result, reason }));
  }

  /** Transport down: nothing can be heard until it is back. */
  transportDown(): void {
    this.failPending(new CyError('DISCONNECTED', 'transport closed'));
    this.cancelTimer();
    this.running = false;
    this.markLost();
  }

  resume(): void {
    this.running = true;
    this.lastAlive = this.host.ctx.scheduler.now();
    this.arm();
  }

  dispose(error: CyError): void {
    this.removed = true;
    this.failPending(error);
    this.cancelTimer();
    this.online = false;
    this.signalListeners.clear();
  }

  // ---------------------------------------------------------------------------------------
  // Supervision: one lazily re-armed timer covers "lost" and "telemetry stale"

  private arm(): void {
    if (this.removed || !this.running || !this.online) return;
    const t = this.host.timings;
    let due = this.lastAlive + t.lostAfterMs;
    if (!this.stale && this.lastTelemetry >= 0) due = Math.min(due, this.lastTelemetry + t.telemetryTimeoutMs);
    // A pending timer that fires early only re-arms itself; one that would fire too late is replaced.
    if (this.timer !== undefined) {
      if (this.timerDue <= due) return;
      this.cancelTimer();
    }
    const s = this.host.ctx.scheduler;
    this.timerDue = due;
    this.timer = s.setTimeout(
      () => {
        this.timer = undefined;
        this.evaluate();
        this.arm();
      },
      Math.max(1, due - s.now()),
    );
  }

  private cancelTimer(): void {
    if (this.timer !== undefined) this.host.ctx.scheduler.clearTimeout(this.timer);
    this.timer = undefined;
  }

  private evaluate(): void {
    if (this.removed || !this.online) return;
    const now = this.host.ctx.scheduler.now();
    const t = this.host.timings;
    if (now - this.lastAlive >= t.lostAfterMs) {
      this.markLost();
    } else if (!this.stale && this.lastTelemetry >= 0 && now - this.lastTelemetry >= t.telemetryTimeoutMs) {
      this.markStale(now);
      this.changed();
    }
  }

  markLost(): void {
    if (!this.online) return;
    this.online = false;
    this.markStale(this.host.ctx.scheduler.now());
    this.host.recomputeConflicts(this.num);
    this.host.notify(this, 'deviceLost');
    this.events.emit('changed', this);
  }

  private markFresh(t: number): void {
    this.lastTelemetry = t;
    if (this.stale) {
      this.stale = false;
      this.refreshState();
      this.changed();
    } else if (this.refreshState()) {
      this.changed();
    }
  }

  /** Stale readings: the frozen values stay, but magnet health is no longer trustworthy. */
  private markStale(t: number): void {
    this.stale = true;
    if (!Number.isNaN(this.signalValues[V3Signal.MAGNET_HEALTH])) {
      this.signalValues[V3Signal.MAGNET_HEALTH] = V3Health.UNKNOWN;
      this.emitSignals(t, 1, HEALTH_ONLY);
    }
    this.refreshState();
  }

  /** ACTIVE while readings flow, FAULT on a sensor fault, IDLE when quiet. Returns whether it changed. */
  private refreshState(): boolean {
    let next: number = DeviceState.IDLE;
    if (this.lastTelemetry < 0) next = DeviceState.BOOT;
    else if (!this.stale) next = this.signalValues[V3Signal.MAGNET_HEALTH] === V3Health.SENSOR_FAULT ? DeviceState.FAULT : DeviceState.ACTIVE;
    if (next === this.state) return false;
    this.state = next;
    return true;
  }

  private changed(): void {
    this.host.notify(this, 'deviceChanged');
    this.events.emit('changed', this);
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

  private emitSignals(t: number, frame: number, keys: readonly string[]): void {
    if (this.signalListeners.size === 0) return;
    const u = this.signalUpdate;
    u.t = t;
    u.frame = frame;
    u.keys = keys;
    for (const cb of this.signalListeners) cb(u);
  }

  // ---------------------------------------------------------------------------------------
  // Commands

  command(keyOrCmd: string | number, _arg?: number, _opts?: CommandOptions): Promise<LegacyCommandResult> {
    const action = CYNCODER_V3_DEF.actions.find((a) => a.key === keyOrCmd || a.cmd === keyOrCmd);
    if (!action) return Promise.reject(new CyError('INVALID', `unknown command ${String(keyOrCmd)}`, { reason: 'unknown_command' }));
    return this.sendCommand((action.cmd & ~V3_ACTION_BASE) as V3CommandIndex);
  }

  /** The board's LED blink has a fixed duration; `seconds` is ignored. */
  async identify(_seconds: number): Promise<void> {
    await this.sendCommand(V3Command.BLINK);
  }

  /**
   * Sends a UID-targeted command with a fresh sequence byte and waits for the matching ACK.
   * Firmware older than protocol v3 sends none: the command resolves at once with `confirmed: false`.
   */
  sendCommand(index: V3CommandIndex): Promise<LegacyCommandResult> {
    if (this.removed || !this.host.ctx.isOpen()) return Promise.reject(new CyError('DISCONNECTED', 'bus is not running'));
    if (this.pending) return Promise.reject(new CyError('BUSY', 'another command is waiting for its ACK'));
    const sequence = this.host.nextSequence();
    const frame: TxFrame = encodeTargetedCommand(index, this.num, this.uid32, sequence);
    this.host.ctx.send(frame);
    if (this.protocolVersion !== null && this.protocolVersion < V3_FIRST_ACK_VERSION) {
      return Promise.resolve({ cmd: V3_ACTION_BASE | index, status: 0, result: 0, confirmed: false });
    }
    return new Promise<LegacyCommandResult>((resolve, reject) => {
      const timer = this.host.ctx.scheduler.setTimeout(() => {
        if (this.pending?.sequence !== sequence) return;
        this.pending = null;
        this.host.ctx.countRequestTimeout();
        reject(new CyError('TIMEOUT', `no ACK from board ${this.uidHex}`));
      }, this.host.timings.ackTimeoutMs);
      this.pending = { index, sequence, resolve, reject, timer };
    });
  }

  private clearPending(): void {
    if (this.pending) this.host.ctx.scheduler.clearTimeout(this.pending.timer);
    this.pending = null;
  }

  private failPending(error: CyError): void {
    const p = this.pending;
    if (!p) return;
    this.clearPending();
    p.reject(error);
  }

  private settleUnconfirmed(): void {
    const p = this.pending;
    if (!p) return;
    this.clearPending();
    p.resolve({ cmd: V3_ACTION_BASE | p.index, status: 0, result: 0, confirmed: false });
  }

  // ---------------------------------------------------------------------------------------
  // Not supported by the v3 protocol

  cachedParam(_key: string): number | undefined {
    return undefined;
  }
  getParam(_key: string): Promise<number> {
    return rejectUnsupported('params');
  }
  setParam(_key: string, _value: number): Promise<number> {
    return rejectUnsupported('params');
  }
  readAllParams(): Promise<ReadAllResult> {
    return rejectUnsupported('params');
  }
  save(): Promise<void> {
    return rejectUnsupported('params');
  }
  loadDefaults(): Promise<void> {
    return rejectUnsupported('params');
  }
  loadSaved(): Promise<void> {
    return rejectUnsupported('params');
  }
  rename(_name: string): Promise<void> {
    return rejectUnsupported('rename');
  }
  reboot(): Promise<void> {
    return rejectUnsupported('reboot');
  }
  clearFaults(): Promise<void> {
    return rejectUnsupported('faults');
  }
  selfTest(): Promise<SelfTestResult> {
    return rejectUnsupported('selfTest');
  }
  clearEstop(): Promise<void> {
    return rejectUnsupported('estop');
  }
  readFaults(): Promise<DeviceFaults> {
    return rejectUnsupported('faults');
  }
}
