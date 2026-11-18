import type { ModelDef } from '../catalog/schema';
import { type CanFrame, type TxFrame, BROADCAST_ALL } from '../core/frame';
import {
  Command,
  ESTOP_REPEAT_COUNT,
  ESTOP_REPEAT_GAP_MS,
  RECOVERY_BEACON_PERIOD_MS,
  RECOVERY_STAY_MAGIC,
} from '../core/constants';
import { validateCyfw } from '../core/cyfw';
import { encodeCommand, encodeEstop } from '../core/messages';
import type { Scheduler, Transport, TransportState } from '../transport/types';
import { CyCanDriver, type ResolveOutcome, type ResolveStep } from './cycan/driver';
import { describeFrame } from './describe';
import { Emitter } from './emitter';
import { CyError } from './errors';
import { type BusStats, StatsCounter } from './stats';
import { parseUid48 } from './uid';
import type {
  AbortSignalLike,
  BusDriver,
  DeviceEventKind,
  DeviceHandle,
  DriverContext,
  FirmwareProgress,
  FirmwareResult,
  FrameDescription,
  Lang,
} from './types';

export interface BusFrameEvent {
  dir: 'rx' | 'tx';
  frame: CanFrame;
}

export interface BusEvents {
  deviceAdded: DeviceHandle;
  deviceChanged: DeviceHandle;
  deviceLost: DeviceHandle;
  deviceRemoved: DeviceHandle;
  /** Every frame in both directions; built only while someone listens. */
  frame: BusFrameEvent;
  stats: BusStats;
  transportState: TransportState;
  /** Recovery mode started (true) or stopped (false). */
  recovery: boolean;
}

export interface CygnusBusOptions {
  /** Extra drivers, consulted after the CyCAN driver (e.g. legacy Cyncoder v3). */
  drivers?: BusDriver[];
  /** CAN-FD data phase bitrate for the load estimate, Mbit/s. Default 2. */
  dataBitrateMbps?: number;
  /** Stats event period. Default 1000 ms. */
  statsIntervalMs?: number;
}

export interface FirmwareBatchItem {
  device: DeviceHandle;
  ok: boolean;
  /** `aborted`: never started because the link went down while an earlier board was updated. */
  skipped?: 'no_image' | 'same_version' | 'offline' | 'aborted';
  result?: FirmwareResult;
  error?: Error;
}

export interface FirmwareBatchOptions {
  onProgress?: (device: DeviceHandle, p: FirmwareProgress) => void;
  /** Called when a board starts (index into the update list). */
  onDevice?: (device: DeviceHandle, index: number, count: number) => void;
  signal?: AbortSignalLike;
  /** Also flash boards that already run the image's version. */
  force?: boolean;
  /** Restrict to these boards. */
  devices?: readonly DeviceHandle[];
}

const NOMINAL_BPS = 1_000_000;

/**
 * Recovery mode (PROTOCOL §9.0): broadcasts ENTER_BOOTLOADER with the recovery argument every
 * 20 ms, so a board powered up meanwhile stays in its bootloader instead of starting a broken
 * application. The user power-cycles the vehicle while it runs.
 */
export interface BusRecovery {
  readonly active: boolean;
  start(): void;
  stop(): void;
  /** Online boards waiting in their bootloader. */
  readonly devices: DeviceHandle[];
}

/**
 * Bus load estimate for admitting streams (PROTOCOL §10.1): the last measured window, plus
 * what streams committed since that window was measured.
 */
class LoadBudget {
  private committed = 0;
  private atSnapshot = 0;
  private measured = 0;

  commit(delta: number): void {
    this.committed = Math.max(0, this.committed + delta);
  }

  snapshot(measured: number): void {
    this.measured = measured;
    this.atSnapshot = this.committed;
  }

  get estimate(): number {
    return Math.max(0, this.measured - this.atSnapshot) + this.committed;
  }
}

/**
 * Host client for one CAN bus: owns the transport subscription, hands frames to protocol
 * drivers, keeps bus statistics and exposes discovered boards as DeviceHandles.
 */
export class CygnusBus {
  readonly cycan: CyCanDriver;
  private readonly drivers: BusDriver[];
  private readonly events = new Emitter<BusEvents>();
  private readonly stats: StatsCounter;
  private readonly statsIntervalMs: number;
  private statsTimer: unknown = undefined;
  private unsubs: Array<() => void> = [];
  private started = false;
  private linkUp = false;
  private transportState: TransportState = { phase: 'closed' };
  private readonly budget = new LoadBudget();
  private readonly estopTimers = new Set<unknown>();
  private recoveryTimer: unknown = undefined;
  readonly recovery: BusRecovery;

  constructor(
    readonly transport: Transport,
    readonly scheduler: Scheduler,
    opts: CygnusBusOptions = {},
  ) {
    this.cycan = new CyCanDriver();
    this.drivers = [this.cycan, ...(opts.drivers ?? [])];
    this.stats = new StatsCounter(scheduler.now(), NOMINAL_BPS, (opts.dataBitrateMbps ?? 2) * 1_000_000);
    this.statsIntervalMs = opts.statsIntervalMs ?? 1000;
    const budget = this.budget;
    const ctx: DriverContext = {
      scheduler,
      get transportFd() {
        return transport.info.fd;
      },
      isOpen: () => this.linkUp,
      estimatedLoad: () => budget.estimate,
      commitStreamLoad: (delta) => budget.commit(delta),
      send: (f) => this.send(f),
      emitDevice: (kind: DeviceEventKind, d: DeviceHandle) => this.events.emit(kind, d),
      countRequestTimeout: () => {
        this.stats.requestTimeouts++;
      },
      countEnumTimeout: () => {
        this.stats.enumTimeouts++;
      },
    };
    for (const d of this.drivers) d.attach(ctx);
    const bus = this;
    this.recovery = {
      get active() {
        return bus.recoveryTimer !== undefined;
      },
      start: () => this.startRecovery(),
      stop: () => this.stopRecovery(),
      get devices() {
        return bus.devices.filter((d) => d.online && d.bootloader);
      },
    };
  }

  on<K extends keyof BusEvents>(event: K, cb: (payload: BusEvents[K]) => void): () => void {
    return this.events.on(event, cb);
  }

  get running(): boolean {
    return this.started;
  }

  get state(): TransportState {
    return this.transportState;
  }

  get currentStats(): BusStats {
    return this.stats.current;
  }

  /** Opens the transport and starts discovery. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.unsubs.push(
      this.transport.onFrame((f) => this.receive(f)),
      this.transport.onState((s) => this.onTransportState(s)),
    );
    try {
      await this.transport.open();
    } catch (e) {
      this.teardown();
      throw e;
    }
    if (!this.started) return;
    this.linkIsUp();
  }

  /**
   * Stops everything, removes all devices and closes the transport. Boards still driven by a
   * control loop get their neutral command first, while the link is up.
   */
  async stop(): Promise<void> {
    if (!this.started) return;
    if (this.linkUp) for (const d of this.devices) if (d.control?.active) d.control.stop();
    this.teardown();
    await this.transport.close();
    // The state listener is already gone; report the final state ourselves.
    this.transportState = { phase: 'closed' };
    this.events.emit('transportState', this.transportState);
  }

  private teardown(): void {
    this.started = false;
    this.linkUp = false;
    for (const u of this.unsubs) u();
    this.unsubs = [];
    if (this.statsTimer !== undefined) this.scheduler.clearTimeout(this.statsTimer);
    this.statsTimer = undefined;
    for (const t of this.estopTimers) this.scheduler.clearTimeout(t);
    this.estopTimers.clear();
    this.stopRecovery();
    for (const d of this.drivers) d.stop();
  }

  private linkIsUp(): void {
    if (this.linkUp || !this.started) return;
    this.linkUp = true;
    this.stats.snapshot(this.scheduler.now());
    this.armStats();
    for (const d of this.drivers) d.start();
  }

  private onTransportState(s: TransportState): void {
    this.transportState = s;
    this.events.emit('transportState', s);
    if (s.phase === 'open') this.linkIsUp();
    else if (this.linkUp) {
      this.linkUp = false;
      this.stopRecovery();
      for (const d of this.drivers) d.transportDown();
    }
  }

  private armStats(): void {
    this.statsTimer = this.scheduler.setTimeout(() => {
      this.statsTimer = undefined;
      if (!this.started) return;
      const s = this.stats.snapshot(this.scheduler.now());
      this.budget.snapshot(s.loadPct / 100);
      this.armStats();
      this.events.emit('stats', s);
    }, this.statsIntervalMs);
  }

  // ---------------------------------------------------------------------------------------
  // Frames

  /** Sends a raw frame (CAN monitor "send frame"); dropped while the link is down. */
  send(frame: TxFrame): void {
    if (!this.linkUp) return;
    this.stats.countTx(frame);
    if (this.events.has('frame')) {
      this.events.emit('frame', { dir: 'tx', frame: { ...frame, timestamp: this.scheduler.now() } });
    }
    this.transport.send(frame);
  }

  private receive(f: CanFrame): void {
    if (!this.linkUp) return;
    this.stats.countRx(f);
    if (this.events.has('frame')) this.events.emit('frame', { dir: 'rx', frame: f });
    for (const d of this.drivers) if (d.handleFrame(f)) return;
  }

  // ---------------------------------------------------------------------------------------
  // Devices

  /** All known boards (online or lost), ordered by type, number and UID. */
  get devices(): DeviceHandle[] {
    const out: DeviceHandle[] = [];
    for (const d of this.drivers) for (const h of d.devices()) out.push(h);
    return out.sort((a, b) => a.devType - b.devType || a.num - b.num || (a.uid48 < b.uid48 ? -1 : 1));
  }

  device(devType: number, num: number): DeviceHandle | undefined {
    return this.cycan.deviceAt(devType, num);
  }

  /** Looks up a board of any driver by its `uid48` (legacy boards: their UID zero-padded). */
  deviceByUid(uid48: string | number): DeviceHandle | undefined {
    const found = this.cycan.deviceByUid(uid48);
    if (found) return found;
    const want = parseUid48(uid48);
    for (const d of this.drivers) {
      if (d === this.cycan) continue;
      for (const h of d.devices()) if (parseUid48(h.uid48) === want) return h;
    }
    return undefined;
  }

  get unresolved(): DeviceHandle[] {
    return this.cycan.unresolved();
  }

  suggestNumber(devType: number): number | null {
    return this.cycan.suggestNumber(devType);
  }

  assignId(uid48: string | number, num: number, opts: { persist?: boolean; force?: boolean } = {}): Promise<void> {
    return this.cycan.assignId(uid48, num, opts);
  }

  planResolve(): ResolveStep[] {
    return this.cycan.planResolve();
  }

  resolveAll(opts: { persist?: boolean } = {}): Promise<ResolveOutcome[]> {
    return this.cycan.resolveAll(opts);
  }

  identifyByUid(uid48: string | number, seconds: number): void {
    this.cycan.identifyByUid(uid48, seconds);
  }

  /** Removes a board from the list (e.g. a lost board the user dismissed). */
  forget(uid48: string | number): boolean {
    return this.cycan.forget(uid48);
  }

  // ---------------------------------------------------------------------------------------
  // Safety and batch operations

  /**
   * Software emergency stop: ends every control loop first, then broadcasts ESTOP three times,
   * 10 ms apart (PROTOCOL §4.7), so one lost frame does not leave a board running.
   */
  estop(): void {
    for (const d of this.drivers) d.haltControl();
    this.send(encodeEstop(BROADCAST_ALL));
    for (let i = 1; i < ESTOP_REPEAT_COUNT; i++) {
      const t = this.scheduler.setTimeout(() => {
        this.estopTimers.delete(t);
        this.send(encodeEstop(BROADCAST_ALL));
      }, i * ESTOP_REPEAT_GAP_MS);
      this.estopTimers.add(t);
    }
  }

  private startRecovery(): void {
    if (this.recoveryTimer !== undefined || !this.linkUp) return;
    const beacon = (): void => {
      this.send(encodeCommand(BROADCAST_ALL, { cmd: Command.ENTER_BOOTLOADER, arg: RECOVERY_STAY_MAGIC }));
      this.recoveryTimer = this.scheduler.setTimeout(beacon, RECOVERY_BEACON_PERIOD_MS);
    };
    beacon();
    this.events.emit('recovery', true);
  }

  private stopRecovery(): void {
    if (this.recoveryTimer === undefined) return;
    this.scheduler.clearTimeout(this.recoveryTimer);
    this.recoveryTimer = undefined;
    this.events.emit('recovery', false);
  }

  /**
   * Updates every matching board one after another. An image matches a board when its model
   * and hardware revision fit; boards already on that version are skipped unless `force`.
   */
  async updateAllFirmware(images: readonly Uint8Array[], opts: FirmwareBatchOptions = {}): Promise<FirmwareBatchItem[]> {
    const parsed = images.map((img) => ({ img, v: validateCyfw(img) }));
    for (const p of parsed) if (!p.v.ok) throw new CyError('INVALID', `firmware image: ${p.v.error}`, { reason: p.v.error });
    const targets = (opts.devices ?? this.devices).filter((d) => d.capabilities.firmware);
    const out: FirmwareBatchItem[] = [];
    const queue: Array<{ device: DeviceHandle; img: Uint8Array }> = [];
    for (const device of targets) {
      const match = parsed.find((p) => p.v.ok && validateCyfw(p.img, { model: device.model, hwRev: device.hwRev ?? undefined }).ok);
      if (!match || !match.v.ok) {
        out.push({ device, ok: false, skipped: 'no_image' });
        continue;
      }
      const h = match.v.header;
      const fw = device.fw;
      if (!opts.force && fw && fw.major === h.fwMajor && fw.minor === h.fwMinor && fw.patch === h.fwPatch) {
        out.push({ device, ok: true, skipped: 'same_version' });
        continue;
      }
      if (!device.online) {
        out.push({ device, ok: false, skipped: 'offline' });
        continue;
      }
      queue.push({ device, img: match.img });
    }
    for (let i = 0; i < queue.length; i++) {
      const item = queue[i];
      if (!item) continue;
      if (opts.signal?.aborted) {
        out.push({ device: item.device, ok: false, error: new CyError('ABORTED', 'aborted') });
        continue;
      }
      opts.onDevice?.(item.device, i, queue.length);
      try {
        const result = await item.device.firmware.update(item.img, {
          signal: opts.signal,
          onProgress: (p) => opts.onProgress?.(item.device, p),
        });
        out.push({ device: item.device, ok: true, result });
      } catch (e) {
        out.push({ device: item.device, ok: false, error: e instanceof Error ? e : new Error(String(e)) });
        if (e instanceof CyError && e.code === 'DISCONNECTED') {
          for (const rest of queue.slice(i + 1)) {
            out.push({ device: rest.device, ok: false, skipped: 'aborted', error: new CyError('DISCONNECTED', 'link went down') });
          }
          break;
        }
      }
    }
    return out;
  }

  // ---------------------------------------------------------------------------------------
  // CAN monitor

  /** Human-readable frame decoding with models looked up from discovered boards. */
  describeFrame(frame: CanFrame, lang: Lang = 'tr'): FrameDescription {
    const modelAt = (devType: number, num: number): ModelDef | undefined => this.cycan.deviceAt(devType, num)?.def;
    for (const d of this.drivers) {
      if (d === this.cycan) continue;
      const r = d.describe?.(frame, { lang, modelAt });
      if (r) return r;
    }
    return describeFrame(frame, { lang, modelAt });
  }
}
