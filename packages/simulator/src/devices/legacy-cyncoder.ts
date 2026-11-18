import {
  CYNCODER_V3_DEF,
  CYNCODER_V3_MODEL,
  CommandStatus,
  V3Ack,
  V3Class,
  V3Command,
  V3Health,
  V3Telemetry,
  V3_TELEMETRY_PERIOD_MS,
  V3_TICKS_PER_REV,
  V3_UID_PERIOD_MS,
  idClass,
  idIndex,
  idNum,
  isV3Id,
  readU32,
  v3Id,
  writeF32,
  writeU16,
  writeU32,
} from '@cygnus/protocol';
import type { BusFrame } from '../bus';
import { NodeMode, type InjectionKind, type NodeSnapshot } from '../node';
import { CyncoderNode, type CyncoderOptions } from './cyncoder';

export interface LegacyCyncoderOptions extends CyncoderOptions {
  /** CAN number of the v3 firmware (1..62). */
  num: number;
  /** Protocol version the firmware reports: 0 = before v2 (padded health frame), 2, or 3 (ACKs). */
  version?: 0 | 2 | 3;
}

/** How long the LED blinks after a BLINK command, ms. */
const BLINK_MS = 2000;
const ACK_DELAY_MS = 2;

/**
 * Cyncoder 1.4 running the legacy "Cyncoder v3" FRC firmware (PROTOCOL §11): DEVTYPE 10,
 * CLASS 0 telemetry (100 Hz position/velocity and magnet health, 2 Hz UID) and CLASS 1
 * UID-targeted commands with an ACK from protocol v3 on. The sensor physics are the CyCAN
 * Cyncoder's; the board never answers CyCAN frames.
 */
export class LegacyCyncoderNode extends CyncoderNode {
  protected override readonly speaksCyCan = false;
  readonly uid32: number;
  version: 0 | 2 | 3;
  /** Commands this board accepted (UID matched), for tests and the panel. */
  readonly applied: Array<{ index: number; sequence: number | null }> = [];
  busOffCount = 0;
  private sensorFault = false;
  private blinkUntil = -1;
  private nextTelemetry = 0;
  private nextUid = 0;
  private readonly acks: Array<{ at: number; index: number; result: number; sequence: number }> = [];
  private readonly frame = new Uint8Array(8);
  private readonly sPos: number;
  private readonly sVel: number;
  private readonly sAbs: number;
  private readonly sAgc: number;

  constructor(o: LegacyCyncoderOptions) {
    super(o);
    this.version = o.version ?? 3;
    this.uid32 = this.uid48 % 0x1_0000_0000;
    this.sPos = this.sigIndex('position');
    this.sVel = this.sigIndex('velocity');
    this.sAbs = this.sigIndex('abs.position');
    this.sAgc = this.sigIndex('magnet.agc');
  }

  protected override onAppStart(): void {
    super.onAppStart();
    // Phase from the UID so several boards do not send in lock step.
    this.nextTelemetry = this.now + (this.uid32 % V3_TELEMETRY_PERIOD_MS);
    this.nextUid = this.now + (this.uid32 % V3_UID_PERIOD_MS);
    this.acks.length = 0;
    this.blinkUntil = -1;
  }

  protected override appTick(): void {
    super.appTick();
    const now = this.now;
    while (this.acks.length > 0 && this.acks[0]!.at <= now) {
      const a = this.acks.shift()!;
      const d = this.frame;
      d.fill(0);
      d[0] = a.index;
      d[1] = a.result;
      d[2] = a.sequence;
      writeU32(d, 4, this.uid32);
      this.emit(V3Telemetry.COMMAND_ACK, d);
    }
    if (now >= this.nextTelemetry) {
      this.nextTelemetry += V3_TELEMETRY_PERIOD_MS;
      if (this.nextTelemetry <= now) this.nextTelemetry = now + V3_TELEMETRY_PERIOD_MS;
      // The firmware stops position frames on a sensor fault but keeps reporting health.
      if (!this.sensorFault) {
        const d = this.frame;
        writeF32(d, 0, (this.sig[this.sPos] ?? 0) * 360);
        writeF32(d, 4, (this.sig[this.sVel] ?? 0) * 6);
        this.emit(V3Telemetry.POSITION_VELOCITY, d);
      }
      this.emit(V3Telemetry.MAGNET_HEALTH, this.healthPayload());
    }
    if (now >= this.nextUid) {
      this.nextUid += V3_UID_PERIOD_MS;
      if (this.nextUid <= now) this.nextUid = now + V3_UID_PERIOD_MS;
      const d = new Uint8Array(4);
      writeU32(d, 0, this.uid32);
      this.emit(V3Telemetry.DEVICE_UID, d);
    }
  }

  private healthPayload(): Uint8Array {
    const d = this.frame;
    d.fill(0);
    let health: number = V3Health.GOOD;
    let field = 2000;
    if (this.sensorFault) {
      health = V3Health.SENSOR_FAULT;
      field = 0;
    } else if (this.magnet === 'weak') {
      health = V3Health.FAR;
      field = 400;
    } else if (this.magnet === 'missing' || this.magnet === 'strong') {
      health = V3Health.ERROR;
      field = this.magnet === 'missing' ? 0 : 3900;
    }
    d[0] = health;
    d[1] = Math.round(this.sig[this.sAgc] ?? 0) & 0xff;
    writeU16(d, 2, field & 0x0fff);
    if (this.version >= 2) {
      const ticks = Math.floor((this.sig[this.sAbs] ?? 0) * V3_TICKS_PER_REV) & (V3_TICKS_PER_REV - 1);
      writeU16(d, 4, ticks);
      d[6] = this.version;
      d[7] = this.busOffCount & 0xff;
    }
    return d;
  }

  private emit(index: number, data: Uint8Array): void {
    this.ctx.bus.transmit(this, v3Id(V3Class.TELEMETRY, index, this.num), data, data.length, false, false);
  }

  override receive(f: BusFrame): void {
    if (this.mode !== NodeMode.APP || !isV3Id(f.id) || idClass(f.id) !== V3Class.COMMAND) return;
    if (idNum(f.id) !== this.num || f.len < 4 || readU32(f.data, 0) !== this.uid32) return;
    const index = idIndex(f.id);
    const sequence = f.len >= 5 ? (f.data[4] ?? 0) : null;
    this.applied.push({ index, sequence });
    const result = this.execute(index);
    if (this.version >= 3 && sequence !== null) this.acks.push({ at: this.now + ACK_DELAY_MS, index, result, sequence });
  }

  private execute(index: number): number {
    switch (index) {
      case V3Command.SET_ZERO: {
        // Same as the CyCAN "zero here" action, then written to flash as the v3 firmware does.
        const r = this.action(0x40);
        if (r.status !== CommandStatus.OK) return V3Ack.NOT_READY;
        this.params.save();
        return V3Ack.OK;
      }
      case V3Command.FACTORY_DEFAULT:
        this.params.setKey('enc.zero_offset_rot', 0);
        this.params.setKey('enc.invert', 0);
        this.params.save();
        this.action(0x41);
        return V3Ack.OK;
      case V3Command.BLINK:
        this.blinkUntil = this.now + BLINK_MS;
        return V3Ack.OK;
    }
    // SET_CONFIG carries a configuration word the Studio never sends; nothing else is defined.
    return V3Ack.INVALID_ARGUMENT;
  }

  get blinking(): boolean {
    return this.mode === NodeMode.APP && this.now < this.blinkUntil;
  }

  override txError(): void {}

  override inject(kind: InjectionKind, on = true, arg = 0): boolean {
    // A hardware fault on this board is the AS5600 failing: health SENSOR_FAULT, no position.
    if (kind === 'hardware') this.sensorFault = on;
    return super.inject(kind, on, arg);
  }

  override snapshot(connected: boolean): NodeSnapshot {
    const s = super.snapshot(connected);
    return {
      ...s,
      model: CYNCODER_V3_MODEL,
      modelKey: CYNCODER_V3_DEF.key,
      devType: CYNCODER_V3_DEF.devType,
      uid48: this.uid32,
      uid48Hex: this.uid32.toString(16).padStart(12, '0'),
      name: '',
      identify: this.blinking,
      unsaved: false,
    };
  }
}
