import type { ModelDef } from '../catalog/schema';
import { type CanFrame, type TxFrame, BROADCAST_ALL } from '../core/frame';
import { validateCyfw } from '../core/cyfw';
import { encodeEstop } from '../core/messages';
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
  skipped?: 'no_image' | 'same_version' | 'offline';
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

  constructor(
    readonly transport: Transport,
    readonly scheduler: Scheduler,
    opts: CygnusBusOptions = {},
  ) {
    this.cycan = new CyCanDriver();
    this.drivers = [this.cycan, ...(opts.drivers ?? [])];
    this.stats = new StatsCounter(scheduler.now(), NOMINAL_BPS, (opts.dataBitrateMbps ?? 2) * 1_000_000);
    this.statsIntervalMs = opts.statsIntervalMs ?? 1000;
    const ctx: DriverContext = {
      scheduler,
      transportFd: transport.info.fd,
      isOpen: () => this.linkUp,
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

  /** Stops everything, removes all devices and closes the transport. */
  async stop(): Promise<void> {
    if (!this.started) return;
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
      for (const d of this.drivers) d.transportDown();
    }
  }

  private armStats(): void {
    this.statsTimer = this.scheduler.setTimeout(() => {
      this.statsTimer = undefined;
      if (!this.started) return;
      const s = this.stats.snapshot(this.scheduler.now());
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

  /** Software emergency stop: ends every control loop first, then broadcasts ESTOP. */
  estop(): void {
    for (const d of this.drivers) d.haltControl();
    this.send(encodeEstop(BROADCAST_ALL));
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
        if (e instanceof CyError && e.code === 'DISCONNECTED') break;
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
