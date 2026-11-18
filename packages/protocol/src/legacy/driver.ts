import type { CanFrame } from '../core/frame';
import { disconnectedError, CyError } from '../host/errors';
import type { BusDriver, DescribeOptions, DeviceEventKind, DeviceHandle, DriverContext, FrameDescription } from '../host/types';
import { parseUid48 } from '../host/uid';
import { describeV3Frame } from './describe';
import { CyncoderV3Device, type LegacyHost, type LegacyTimings } from './device';
import { V3_TELEMETRY_PERIOD_MS, V3_UID_PERIOD_MS, isV3Id, parseV3Frame } from './protocol';

export interface CyncoderV3DriverOptions extends Partial<LegacyTimings> {
  /** First command sequence number (1..255); random by default. Fixed values make tests repeatable. */
  initialSequence?: number;
}

const DEFAULT_TIMINGS: LegacyTimings = {
  // Three missed 2 Hz identity frames; every telemetry frame also counts as proof of life.
  lostAfterMs: V3_UID_PERIOD_MS * 3,
  // Telemetry is 100 Hz; a USB adapter may batch, so allow far more than one period.
  telemetryTimeoutMs: V3_TELEMETRY_PERIOD_MS * 25,
  // The robot library waits 0.5 s: commands that write Flash can be slow.
  ackTimeoutMs: 500,
};

/**
 * Legacy Cyncoder v3 (FRC identifier layout) boards. They are discovered passively from the
 * 2 Hz identity frame; the 32-bit UID is the identity because several boards may share a CAN
 * number. Telemetry carries no UID, so while two online boards share a number their readings
 * are withheld (commands still work: the firmware obeys only its own UID).
 */
export class CyncoderV3Driver implements BusDriver, LegacyHost {
  readonly id = 'cyncoder-v3';
  ctx!: DriverContext;
  readonly timings: LegacyTimings;
  private readonly byUid = new Map<number, CyncoderV3Device>();
  private readonly byNum = new Map<number, CyncoderV3Device[]>();
  private sequence: number;
  private running = false;

  constructor(opts: CyncoderV3DriverOptions = {}) {
    this.timings = {
      lostAfterMs: opts.lostAfterMs ?? DEFAULT_TIMINGS.lostAfterMs,
      telemetryTimeoutMs: opts.telemetryTimeoutMs ?? DEFAULT_TIMINGS.telemetryTimeoutMs,
      ackTimeoutMs: opts.ackTimeoutMs ?? DEFAULT_TIMINGS.ackTimeoutMs,
    };
    const first = opts.initialSequence ?? 1 + Math.floor(Math.random() * 255);
    // Sequence 0 means "no sequence" on the wire.
    this.sequence = ((first - 1) & 0xff) % 255 + 1;
  }

  attach(ctx: DriverContext): void {
    this.ctx = ctx;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    for (const d of this.byUid.values()) d.resume();
  }

  transportDown(): void {
    this.running = false;
    for (const d of this.byUid.values()) d.transportDown();
  }

  stop(): void {
    this.running = false;
    const err = new CyError('DISCONNECTED', 'bus stopped');
    const all = [...this.byUid.values()];
    this.byUid.clear();
    this.byNum.clear();
    for (const d of all) {
      d.dispose(err);
      this.ctx.emitDevice('deviceRemoved', d);
    }
  }

  haltControl(): void {}

  devices(): Iterable<DeviceHandle> {
    return this.byUid.values();
  }

  deviceByUid(uid: string | number): CyncoderV3Device | undefined {
    return this.byUid.get(parseUid48(uid));
  }

  /** Every known board answering to a CAN number (more than one while they share it). */
  devicesAt(num: number): readonly CyncoderV3Device[] {
    return this.byNum.get(num) ?? [];
  }

  /** Removes a board from the list (e.g. a lost board the user dismissed). */
  forget(uid: string | number): boolean {
    const dev = this.byUid.get(parseUid48(uid));
    if (!dev) return false;
    this.byUid.delete(dev.uid32);
    this.removeFromNum(dev, dev.num);
    dev.dispose(disconnectedError());
    this.ctx.emitDevice('deviceRemoved', dev);
    this.recomputeConflicts(dev.num);
    return true;
  }

  // ---------------------------------------------------------------------------------------
  // Frame routing

  handleFrame(frame: CanFrame): boolean {
    if (!isV3Id(frame.id)) return false;
    const f = parseV3Frame(frame);
    const now = frame.timestamp;
    switch (f.kind) {
      case 'uid':
        this.onUid(f.uid, f.num, now);
        break;
      case 'position':
        this.soleAt(f.num)?.applyPosition(f.value, now);
        break;
      case 'health':
        this.soleAt(f.num)?.applyHealth(f.value, now);
        break;
      case 'ack':
        this.byUid.get(f.ack.uid)?.applyAck(f.ack, now);
        break;
      // Commands from other hosts and malformed frames are claimed but carry nothing for us.
      default:
        break;
    }
    return true;
  }

  describe(frame: CanFrame, opts: DescribeOptions): FrameDescription | null {
    return describeV3Frame(frame, opts);
  }

  private onUid(uid: number, num: number, now: number): void {
    const known = this.byUid.get(uid);
    if (known) {
      known.applyNum(num);
      known.touch(now);
      return;
    }
    const dev = new CyncoderV3Device(this, uid, num, now);
    this.byUid.set(uid, dev);
    this.addToNum(dev);
    this.ctx.emitDevice('deviceAdded', dev);
    this.recomputeConflicts(num);
  }

  /** The one board telemetry at `num` can belong to, or undefined when that is ambiguous or unknown. */
  private soleAt(num: number): CyncoderV3Device | undefined {
    const list = this.byNum.get(num);
    if (!list || list.length === 0) return undefined;
    if (list.length === 1) return list[0];
    const online = list.filter((d) => d.online);
    return online.length === 1 ? online[0] : undefined;
  }

  // ---------------------------------------------------------------------------------------
  // LegacyHost

  nextSequence(): number {
    const s = this.sequence;
    this.sequence = s === 255 ? 1 : s + 1;
    return s;
  }

  notify(device: CyncoderV3Device, kind: DeviceEventKind): void {
    this.ctx.emitDevice(kind, device);
  }

  reindex(device: CyncoderV3Device, oldNum: number): void {
    this.removeFromNum(device, oldNum);
    this.addToNum(device);
    this.recomputeConflicts(oldNum);
    this.recomputeConflicts(device.num);
  }

  recomputeConflicts(num: number): void {
    const list = this.byNum.get(num);
    if (!list) return;
    const online = list.filter((d) => d.online).length;
    for (const d of list) d.setConflict(d.online && online > 1);
  }

  private addToNum(dev: CyncoderV3Device): void {
    const list = this.byNum.get(dev.num);
    if (list) list.push(dev);
    else this.byNum.set(dev.num, [dev]);
  }

  private removeFromNum(dev: CyncoderV3Device, num: number): void {
    const list = this.byNum.get(num)?.filter((d) => d !== dev);
    if (list && list.length > 0) this.byNum.set(num, list);
    else this.byNum.delete(num);
  }
}
