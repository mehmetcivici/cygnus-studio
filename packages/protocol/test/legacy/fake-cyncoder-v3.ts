import { writeF32, writeU32 } from '../../src/core/bytes';
import type { CanFrame, TxFrame } from '../../src/core/frame';
import { idClass, idIndex, idNum } from '../../src/core/id';
import { V3Ack, V3Class, V3Command, V3Telemetry, isV3Id, v3Id } from '../../src/legacy/protocol';
import type { BusNode, FakeBus } from '../helpers/fake-bus';

export interface FakeV3Options {
  uid: number;
  num: number;
  /** Protocol version the firmware reports: 0 = before v2 (padded bytes), 2 = v2, 3 = v3 (ACKs). */
  version?: 0 | 2 | 3;
  health?: number;
  agc?: number;
  magnitude?: number;
  /** Delay between a command and its ACK, ms. */
  ackDelayMs?: number;
}

/**
 * A legacy Cyncoder board as the robot-side Java library describes it: 100 Hz position and
 * magnet-health frames, a 2 Hz UID frame, UID-targeted commands that are ignored by any other
 * board, and (version >= 3) a COMMAND_ACK that echoes command, sequence and UID.
 */
export class FakeCyncoderV3 implements BusNode {
  uid: number;
  num: number;
  version: 0 | 2 | 3;
  positionDeg = 0;
  velocityDps = 0;
  health: number;
  agc: number;
  magnitude: number;
  busOff = 0;
  /** Result code of the next ACKs (V3Ack.*, or any byte). */
  ackResult: number = V3Ack.OK;
  /** Version >= 3 board that nevertheless stays silent. */
  silent = false;
  ackDelayMs: number;
  /** Commands accepted by this board (UID matched): [index, sequence | null]. */
  readonly applied: Array<{ index: number; sequence: number | null }> = [];
  blinks = 0;
  private telemetryOn = true;
  private positionOn = true;
  private powered = true;

  constructor(
    private readonly bus: FakeBus,
    opts: FakeV3Options,
  ) {
    this.uid = opts.uid >>> 0;
    this.num = opts.num;
    this.version = opts.version ?? 3;
    this.health = opts.health ?? 0;
    this.agc = opts.agc ?? 128;
    this.magnitude = opts.magnitude ?? 2000;
    this.ackDelayMs = opts.ackDelayMs ?? 2;
    bus.attach(this);
    this.loopTelemetry();
    this.loopUid();
  }

  /** Board drops off the bus entirely. */
  powerOff(): void {
    this.powered = false;
  }

  powerOn(): void {
    if (this.powered) return;
    this.powered = true;
    this.loopTelemetry();
    this.loopUid();
  }

  /** Stops position and health frames but keeps the 2 Hz identity frame. */
  muteTelemetry(): void {
    this.telemetryOn = false;
  }

  unmuteTelemetry(): void {
    this.telemetryOn = true;
  }

  /** Sensor fault: health code 3 and no position frames (as the firmware does). */
  sensorFault(): void {
    this.health = 3;
    this.positionOn = false;
  }

  receive(frame: CanFrame): void {
    if (!this.powered || !isV3Id(frame.id) || idClass(frame.id) !== V3Class.COMMAND) return;
    if (idNum(frame.id) !== this.num || frame.data.length < 4) return;
    const target = ((frame.data[0] ?? 0) | ((frame.data[1] ?? 0) << 8) | ((frame.data[2] ?? 0) << 16) | ((frame.data[3] ?? 0) << 24)) >>> 0;
    if (target !== this.uid) return;
    const index = idIndex(frame.id);
    const sequence = frame.data.length >= 5 ? (frame.data[4] ?? 0) : null;
    this.applied.push({ index, sequence });
    if (index === V3Command.SET_ZERO) this.positionDeg = 0;
    if (index === V3Command.BLINK) this.blinks++;
    if (this.version >= 3 && !this.silent && sequence !== null) {
      this.bus.scheduler.setTimeout(() => this.sendAck(index, sequence), this.ackDelayMs);
    }
  }

  sendAck(index: number, sequence: number, overrides: { uid?: number; result?: number } = {}): void {
    const d = new Uint8Array(8);
    d[0] = index;
    d[1] = overrides.result ?? this.ackResult;
    d[2] = sequence;
    writeU32(d, 4, overrides.uid ?? this.uid);
    this.emit(V3Telemetry.COMMAND_ACK, d);
  }

  private emit(index: number, data: Uint8Array): void {
    if (!this.powered) return;
    const f: TxFrame = { id: v3Id(V3Class.TELEMETRY, index, this.num), data, fd: false, brs: false };
    this.bus.fromNode(this, f);
  }

  private loopTelemetry(): void {
    this.bus.scheduler.setTimeout(() => {
      if (!this.powered) return;
      if (this.telemetryOn) {
        if (this.positionOn) {
          this.positionDeg += (this.velocityDps * 10) / 1000;
          const p = new Uint8Array(8);
          writeF32(p, 0, this.positionDeg);
          writeF32(p, 4, this.velocityDps);
          this.emit(V3Telemetry.POSITION_VELOCITY, p);
        }
        this.emit(V3Telemetry.MAGNET_HEALTH, this.healthPayload());
      }
      this.loopTelemetry();
    }, 10);
  }

  private loopUid(): void {
    this.bus.scheduler.setTimeout(() => {
      if (!this.powered) return;
      const d = new Uint8Array(4);
      writeU32(d, 0, this.uid);
      this.emit(V3Telemetry.DEVICE_UID, d);
      this.loopUid();
    }, 500);
  }

  healthPayload(): Uint8Array {
    const d = new Uint8Array(8);
    d[0] = this.health;
    d[1] = this.agc;
    d[2] = this.magnitude & 0xff;
    d[3] = (this.magnitude >> 8) & 0x0f;
    if (this.version >= 2) {
      const ticks = Math.round((((this.positionDeg % 360) + 360) % 360) / 360 * 4096) & 4095;
      d[4] = ticks & 0xff;
      d[5] = ticks >> 8;
      d[6] = this.version;
      d[7] = this.busOff;
    }
    return d;
  }
}
