import type { BitDef, ModelDef, Text } from '../catalog/schema';
import type { CanFrame, TxFrame } from '../core/frame';
import type { Scheduler } from '../transport/types';

export type Lang = 'tr' | 'en';

/** Structural subset of the DOM AbortSignal, so the package stays runtime neutral. */
export interface AbortSignalLike {
  readonly aborted: boolean;
  addEventListener(type: 'abort', listener: () => void): void;
  removeEventListener(type: 'abort', listener: () => void): void;
}

/**
 * What a device handle can do. CyCAN boards support everything their catalog entry allows;
 * other drivers (e.g. legacy Cyncoder v3) switch off what their protocol lacks, and the
 * corresponding methods reject with NOT_SUPPORTED.
 */
export interface DeviceCapabilities {
  params: boolean;
  signals: boolean;
  stream: boolean;
  control: boolean;
  commands: boolean;
  faults: boolean;
  firmware: boolean;
  rename: boolean;
  identify: boolean;
  /** Number can be changed with `bus.assignId`. */
  assignId: boolean;
}

/** `unknownModel`: no catalog entry; `newerCatalog`: the board reports a newer catalog_rev than ours. */
export type CatalogStatus = 'ok' | 'unknownModel' | 'newerCatalog';

export interface FwVersion {
  major: number;
  minor: number;
  patch: number;
}

export interface BuildInfo {
  gitHash: number;
  /** Days since 2026-01-01. */
  buildDay: number;
  dirty: boolean;
}

export interface DeviceFlags {
  unsaved: boolean;
  enabled: boolean;
  warning: boolean;
  identify: boolean;
}

export interface ResolvedFault {
  bit: number;
  key: string;
  label: Text;
  kind: 'active' | 'sticky' | 'warn';
}

export interface DeviceFaults {
  active: number;
  sticky: number;
  warn: number;
  /** Bits resolved through the common + model fault tables; unknown bits get key `bit<n>`. */
  list: readonly ResolvedFault[];
}

/**
 * Passed to `onSignals` once per received STATUS frame. The object and its `values` record
 * are reused: read them inside the callback, copy if you need to keep them.
 */
export interface SignalUpdate {
  /** Host receive time, ms. */
  readonly t: number;
  /** STATUS frame index. */
  readonly frame: number;
  /** Signal keys this frame carried. */
  readonly keys: readonly string[];
  /** All latest signal values of the device (NaN until first seen). */
  readonly values: Readonly<Record<string, number>>;
}

export interface CommandOptions {
  /** Called on every IN_PROGRESS answer. */
  onProgress?: () => void;
  /** How long to wait for the final answer after IN_PROGRESS. Default 60 s. */
  finalTimeoutMs?: number;
}

export interface CommandResult {
  cmd: number;
  /** CommandStatus of the final answer (always OK when the promise resolves). */
  status: number;
  result: number;
}

export interface SelfTestResult {
  passed: boolean;
  mask: number;
  /** Failed bits resolved through the catalog `selfTestBits`. */
  failed: BitDef[];
}

export interface ReadAllProgress {
  done: number;
  total: number;
}

export interface ReadAllResult {
  values: Record<string, number>;
  failed: Array<{ key: string; error: Error }>;
}

export type ControlFields =
  | { mode: number | string; value: number }
  | { pulsesUs: readonly number[] }
  | { line: number; col: number; text: string };

/**
 * Why a control session ended. `stopped` is the owner's own `stop()`; every other reason is
 * the host ending the session on its own (PROTOCOL §7: the host stops driving a board whose
 * ENABLED bit drops, that reports BOOT/ESTOP/FAULT or whose number changes).
 */
export type ControlStopReason =
  /** `stop()` by the owner, or the bus was stopped by the user (neutral sent). */
  | 'stopped'
  /** `bus.estop()`. */
  | 'estop'
  /** The board reports ESTOP (sent by another node, e.g. a roboRIO or a second Studio). */
  | 'boardEstop'
  /** The board restarted (heartbeat `state = BOOT`). */
  | 'boardReset'
  /** The board reports FAULT. */
  | 'boardFault'
  /** The board is in its bootloader. */
  | 'bootloader'
  /** The board's ENABLED bit dropped while it was being driven (CTRL timeout, fault, …). */
  | 'disabled'
  /** The board's number changed; the old address got a neutral command. */
  | 'renumbered'
  /** The board went into CONFLICT or lost its number. */
  | 'unresolved'
  /** No heartbeat for 1.5 s. */
  | 'lost'
  /** The transport closed or the bus stopped. */
  | 'disconnected';

export type ControlStopCallback = (reason: ControlStopReason) => void;

export interface ControlLoop {
  readonly active: boolean;
  /** Why the session ended; null while it runs. */
  readonly stopReason: ControlStopReason | null;
  update(value: number): void;
  setMode(mode: number | string, value?: number): void;
  /** Stops the device's control session and sends neutral commands. */
  stop(): void;
  /** Called once when the session ends, with the reason (also when it already ended). */
  onStopped(cb: ControlStopCallback): () => void;
}

export interface DeviceControl {
  /** True while a periodic session is running. */
  readonly active: boolean;
  /** Repeat period of the running session, ms. */
  readonly periodMs: number;
  /**
   * One-shot `set`-format command (the board times out after `ctrl.timeout_ms`). Unless a
   * session already drives that frame, a neutral command goes first (PROTOCOL §7 neutral-first rule).
   */
  set(mode: number | string, value: number): void;
  /**
   * Starts (or retargets) the periodic session with a `set`-format command. A new session
   * sends a neutral command first, then the target; every frame is encoded with the board's
   * current address.
   */
  start(mode: number | string, value: number, opts?: { rateHz?: number; onStopped?: ControlStopCallback }): ControlLoop;
  /** Any catalog control frame by key; with `repeat` it joins the periodic session. */
  send(controlKey: string, fields: ControlFields, opts?: { repeat?: boolean; rateHz?: number }): void;
  /** Ends the session and sends neutral commands for every frame it carried. */
  stop(): void;
}

export interface StreamOpenOptions {
  signals: readonly string[];
  /** Requested sample period; shared streams run at the fastest requested period. */
  periodUs: number;
}

/** `values` is reused between calls and ordered like `signals`. `t` is host time in ms. */
export type StreamDataCallback = (t: number, values: Float32Array) => void;

export interface StreamSubscription {
  readonly signals: readonly string[];
  /** Period the board is actually asked for (after sharing and the model minimum), µs. */
  readonly periodUs: number;
  /** Samples lost according to `seq` gaps since this subscription opened. */
  readonly lost: number;
  readonly samples: number;
  readonly closed: boolean;
  onData(cb: StreamDataCallback): () => void;
  close(): void;
}

export interface DeviceStream {
  readonly active: boolean;
  /** Slots in use on the board (0..15). */
  readonly slotsUsed: number;
  open(opts: StreamOpenOptions): StreamSubscription;
}

export type FirmwarePhase = 'validate' | 'enterBootloader' | 'erase' | 'transfer' | 'finish' | 'verify';

export interface FirmwareProgress {
  phase: FirmwarePhase;
  /** Bytes acknowledged by the board. */
  sent: number;
  total: number;
  /** 0..1 over the whole update. */
  fraction: number;
  rewinds: number;
}

export interface FirmwareUpdateOptions {
  onProgress?: (p: FirmwareProgress) => void;
  signal?: AbortSignalLike;
  /** DATA chunk size: `auto` uses FD (61 B) when the link and board allow it, else classic (5 B). */
  chunk?: 'auto' | 'fd' | 'classic';
}

export interface FirmwareResult {
  version: FwVersion;
  previous: FwVersion | null;
  bytes: number;
  rewinds: number;
  durationMs: number;
}

export interface DeviceFirmware {
  readonly busy: boolean;
  update(image: Uint8Array, opts?: FirmwareUpdateOptions): Promise<FirmwareResult>;
}

export interface DeviceEvents {
  /** Identity, state, flags, faults, number, name or online status changed. */
  changed: DeviceHandle;
  paramChanged: { key: string; value: number };
  /** Cached parameter values are stale (after LOAD_DEFAULTS, LOAD_SAVED or a reboot). */
  paramsInvalidated: DeviceHandle;
  /** The periodic control session ended (any reason, including the owner's `stop()`). */
  controlStopped: { reason: ControlStopReason };
}

/** Driver-independent view of one board. Identity is `uid48`; the number may change. */
export interface DeviceHandle {
  readonly driver: string;
  readonly capabilities: Readonly<DeviceCapabilities>;
  /** 12 lowercase hex digits. */
  readonly uid48: string;
  /** 24 hex digits once INFO pages 1–2 were read. */
  readonly uid96: string | null;
  readonly model: number;
  readonly def: ModelDef | undefined;
  readonly catalogStatus: CatalogStatus;
  readonly devType: number;
  readonly num: number;
  readonly name: string;
  readonly fw: FwVersion | null;
  readonly hwRev: number | null;
  readonly catalogRev: number | null;
  readonly build: BuildInfo | null;
  /** DeviceState from the last heartbeat (BOOT before the first one). */
  readonly state: number;
  readonly flags: Readonly<DeviceFlags>;
  readonly faults: DeviceFaults;
  readonly online: boolean;
  /** Host time of the last frame from this board, ms. */
  readonly lastSeen: number;
  readonly conflict: boolean;
  readonly unassigned: boolean;
  readonly bootloader: boolean;
  /** INFO pages were read (model details, UID, build, name). */
  readonly infoLoaded: boolean;

  on<K extends keyof DeviceEvents>(event: K, cb: (payload: DeviceEvents[K]) => void): () => void;

  readonly params: ReadonlyMap<string, number>;
  cachedParam(key: string): number | undefined;
  getParam(key: string): Promise<number>;
  /** Resolves with the value the board holds afterwards. */
  setParam(key: string, value: number): Promise<number>;
  readAllParams(opts?: { onProgress?: (p: ReadAllProgress) => void; window?: number }): Promise<ReadAllResult>;
  save(): Promise<void>;
  loadDefaults(): Promise<void>;
  /** Reloads the saved parameters into RAM (discards unsaved changes); the cache is dropped. */
  loadSaved(): Promise<void>;
  rename(name: string): Promise<void>;

  readonly signals: Readonly<Record<string, number>>;
  getSignal(key: string): number;
  onSignals(cb: (u: SignalUpdate) => void): () => void;

  command(keyOrCmd: string | number, arg?: number, opts?: CommandOptions): Promise<CommandResult>;
  /**
   * Cancels a running command that moves the mechanism (catalog `movesActuator`): sends the
   * neutral CTRL of every frame that has one, ending any control session first (PROTOCOL §4.5).
   * The pending `command()` then rejects with the board's FAILED. No-op when nothing can be sent.
   */
  abortAction(): void;
  identify(seconds: number): Promise<void>;
  reboot(): Promise<void>;
  clearFaults(): Promise<void>;
  selfTest(opts?: CommandOptions): Promise<SelfTestResult>;
  clearEstop(): Promise<void>;
  readFaults(): Promise<DeviceFaults>;

  readonly control: DeviceControl;
  readonly stream: DeviceStream;
  readonly firmware: DeviceFirmware;
}

export type DeviceEventKind = 'deviceAdded' | 'deviceChanged' | 'deviceLost' | 'deviceRemoved';

/** What a driver may use from the bus. */
export interface DriverContext {
  readonly scheduler: Scheduler;
  /** The transport can carry CAN-FD frames (read live: an adapter may fall back to classic when opening). */
  readonly transportFd: boolean;
  isOpen(): boolean;
  /**
   * Estimated bus load, fraction of the nominal rate: the last measured window plus the
   * streams committed since then (PROTOCOL §10.1).
   */
  estimatedLoad(): number;
  /** Adds (or with a negative value removes) the estimated load of a stream. */
  commitStreamLoad(delta: number): void;
  send(frame: TxFrame): void;
  emitDevice(kind: DeviceEventKind, device: DeviceHandle): void;
  countRequestTimeout(): void;
  countEnumTimeout(): void;
}

/**
 * A protocol driver. The bus hands every received frame to the drivers in order until one
 * claims it. A future legacy Cyncoder v3 driver (DEVTYPE 10, CLASS 0/1) implements this
 * interface and exposes its boards as DeviceHandles with reduced `capabilities`.
 */
export interface BusDriver {
  readonly id: string;
  attach(ctx: DriverContext): void;
  /** Transport is open: start background work (discovery, timers). */
  start(): void;
  /** Returns true when the frame belongs to this driver. */
  handleFrame(frame: CanFrame): boolean;
  /** Transport went away: fail pending requests, stop loops, mark devices offline; keep handles. */
  transportDown(): void;
  /** Bus stops: cancel all timers and requests, remove every device (emitting deviceRemoved). */
  stop(): void;
  devices(): Iterable<DeviceHandle>;
  /** Stop every periodic actuator command without sending more frames. */
  haltControl(): void;
  /** Optional decoder for the CAN monitor; return null for frames it does not know. */
  describe?(frame: CanFrame, opts: DescribeOptions): FrameDescription | null;
}

export interface DescribeOptions {
  lang?: Lang;
  /** Finds the model at an address so STATUS frames can be decoded. */
  modelAt?: (devType: number, num: number) => ModelDef | undefined;
}

export interface FrameField {
  key: string;
  label: string;
  value: string;
}

export interface FrameDescription {
  protocol: 'cycan' | 'unknown' | string;
  /** `toDevice`: host→board class; `fromDevice`: board→host; `unknown` for foreign frames. */
  dir: 'toDevice' | 'fromDevice' | 'unknown';
  devType: number;
  devTypeName: string;
  num: number;
  /** `ESC 20A #3`, `#3`, `broadcast`, `all`, or `hash10=…` for ENUM_RSP. */
  address: string;
  cls: number;
  className: string;
  index: number;
  indexName: string;
  /** One-line summary. */
  summary: string;
  fields: FrameField[];
  /** Payload as spaced hex. */
  raw: string;
}
