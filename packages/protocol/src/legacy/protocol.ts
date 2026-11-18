import type { Text } from '../catalog/schema';
import { readF32, readU16, readU32, writeU32 } from '../core/bytes';
import { DevType, MFR } from '../core/constants';
import type { CanFrame, TxFrame } from '../core/frame';
import { encodeId, idClass, idDevType, idIndex, idMfr, idNum } from '../core/id';

/*
 * Cyncoder v3 wire protocol (FRC identifier layout, classic CAN). The only written source is
 * the robot-side Java library (CyncoderCANProtocol.java); every multi-byte field is little-endian.
 */

/** FRC device type of every v3 frame ("Miscellaneous"). */
export const V3_DEVICE_TYPE = DevType.MISC;
/** Manufacturer code of every v3 frame ("Team Use"). */
export const V3_MANUFACTURER = MFR;

export const V3Class = { TELEMETRY: 0, COMMAND: 1 } as const;

export const V3Telemetry = { POSITION_VELOCITY: 0, MAGNET_HEALTH: 1, DEVICE_UID: 2, COMMAND_ACK: 3 } as const;
export const V3Command = { SET_ZERO: 0, SET_CONFIG: 1, FACTORY_DEFAULT: 2, BLINK: 3 } as const;
export type V3CommandIndex = (typeof V3Command)[keyof typeof V3Command];

/** Result codes of COMMAND_ACK byte 1. */
export const V3Ack = {
  OK: 0,
  FLASH_WRITE_FAILED: 1,
  INVALID_ARGUMENT: 2,
  CAN_ID_CHANGE_FAILED: 3,
  NOT_READY: 4,
} as const;

/** Health codes of the magnet-health frame; `UNKNOWN` is a host-side value (no frame / stale). */
export const V3Health = { GOOD: 0, FAR: 1, ERROR: 2, SENSOR_FAULT: 3, UNKNOWN: -1 } as const;

/** Sensor counts per revolution (12 bit). */
export const V3_TICKS_PER_REV = 4096;
/** First protocol version whose firmware answers commands with an ACK. */
export const V3_FIRST_ACK_VERSION = 3;
/** Telemetry (position, health) period of the firmware, ms. */
export const V3_TELEMETRY_PERIOD_MS = 10;
/** Device-identity frame period, ms. */
export const V3_UID_PERIOD_MS = 500;
/** Highest valid CAN number of a v3 board (0 is broadcast, 63 unused by the library). */
export const V3_NUM_MIN = 1;
export const V3_NUM_MAX = 62;

export interface V3PositionVelocity {
  /** Continuous multi-turn angle, degrees (zero offset and invert already applied). */
  positionDeg: number;
  velocityDps: number;
}

export interface V3MagnetHealth {
  /** Raw health code 0..3 (anything else is mapped to ERROR, as the robot library does). */
  health: number;
  agc: number;
  /** Field-strength magnitude, 12 bit. */
  magnitude: number;
  /** Protocol v2+ extension; null for firmware that zero-pads bytes 4..7. */
  ext: { absTicks: number; version: number; busOffCount: number } | null;
}

export interface V3CommandAck {
  commandIndex: number;
  result: number;
  sequence: number;
  uid: number;
}

export function isV3Id(id: number): boolean {
  return idDevType(id) === V3_DEVICE_TYPE && idMfr(id) === V3_MANUFACTURER && idClass(id) <= V3Class.COMMAND;
}

export function v3Id(cls: number, index: number, num: number): number {
  return encodeId({ devType: V3_DEVICE_TYPE, mfr: V3_MANUFACTURER, cls, index, num });
}

/** Returns null for corrupt frames (short, or a non-finite value), which the robot library ignores. */
export function decodePositionVelocity(d: Uint8Array): V3PositionVelocity | null {
  if (d.length < 8) return null;
  const positionDeg = readF32(d, 0);
  const velocityDps = readF32(d, 4);
  if (!Number.isFinite(positionDeg) || !Number.isFinite(velocityDps)) return null;
  return { positionDeg, velocityDps };
}

export function decodeMagnetHealth(d: Uint8Array): V3MagnetHealth | null {
  if (d.length < 4) return null;
  const raw = d[0] ?? 0;
  let ext: V3MagnetHealth['ext'] = null;
  if (d.length >= 8) {
    const version = d[6] ?? 0;
    // Version 0 identifies firmware older than v2, whose bytes 4..7 are padding.
    if (version !== 0) ext = { absTicks: readU16(d, 4) & (V3_TICKS_PER_REV - 1), version, busOffCount: d[7] ?? 0 };
  }
  return {
    health: raw <= V3Health.SENSOR_FAULT ? raw : V3Health.ERROR,
    agc: d[1] ?? 0,
    magnitude: readU16(d, 2) & 0x0fff,
    ext,
  };
}

export function decodeDeviceUid(d: Uint8Array): number | null {
  return d.length >= 4 ? readU32(d, 0) : null;
}

export function decodeCommandAck(d: Uint8Array): V3CommandAck | null {
  if (d.length < 8) return null;
  return { commandIndex: d[0] ?? 0, result: d[1] ?? 0, sequence: d[2] ?? 0, uid: readU32(d, 4) };
}

/** Payload of SET_ZERO / FACTORY_DEFAULT / BLINK: target UID, then the v3 sequence byte (1..255). */
export function encodeTargetedCommand(commandIndex: V3CommandIndex, num: number, targetUid: number, sequence: number): TxFrame {
  const data = new Uint8Array(5);
  writeU32(data, 0, targetUid);
  data[4] = sequence & 0xff;
  return { id: v3Id(V3Class.COMMAND, commandIndex, num), data, fd: false, brs: false };
}

export function uidToHex(uid: number): string {
  return uid.toString(16).padStart(8, '0');
}

const t = (tr: string, en: string): Text => ({ tr, en });

/** Labels of ACK result codes. */
export const V3_ACK_LABELS: Readonly<Record<number, Text>> = {
  [V3Ack.OK]: t('Uygulandı ve kaydedildi', 'Applied and saved'),
  [V3Ack.FLASH_WRITE_FAILED]: t('Uygulandı ama Flash\'a yazılamadı; yeniden başlatınca kaybolur', 'Applied but the Flash write failed; lost at next power cycle'),
  [V3Ack.INVALID_ARGUMENT]: t('Geçersiz argüman', 'Invalid argument'),
  [V3Ack.CAN_ID_CHANGE_FAILED]: t('CAN numarası değiştirilemedi', 'CAN ID change failed'),
  [V3Ack.NOT_READY]: t('Kart henüz sensör örneği almadı; tekrar deneyin', 'Board has no sensor sample yet; retry'),
};

/** `CyError.reason` for each non-OK ACK result code. */
export const V3_ACK_REASONS: Readonly<Record<number, string>> = {
  [V3Ack.FLASH_WRITE_FAILED]: 'applied_not_saved',
  [V3Ack.INVALID_ARGUMENT]: 'invalid_argument',
  [V3Ack.CAN_ID_CHANGE_FAILED]: 'can_id_change_failed',
  [V3Ack.NOT_READY]: 'not_ready',
};

export type V3Frame =
  | { kind: 'position'; num: number; value: V3PositionVelocity }
  | { kind: 'health'; num: number; value: V3MagnetHealth }
  | { kind: 'uid'; num: number; uid: number }
  | { kind: 'ack'; num: number; ack: V3CommandAck }
  | { kind: 'command'; num: number; index: number; uid: number | null; sequence: number | null }
  | { kind: 'malformed'; num: number };

/** Classifies a v3 frame; callers must have checked `isV3Id`. */
export function parseV3Frame(frame: CanFrame): V3Frame {
  const id = frame.id;
  const num = idNum(id);
  const index = idIndex(id);
  const d = frame.data;
  if (idClass(id) === V3Class.COMMAND) {
    return { kind: 'command', num, index, uid: d.length >= 4 ? readU32(d, 0) : null, sequence: d.length >= 5 ? (d[4] ?? 0) : null };
  }
  switch (index) {
    case V3Telemetry.POSITION_VELOCITY: {
      const value = decodePositionVelocity(d);
      return value ? { kind: 'position', num, value } : { kind: 'malformed', num };
    }
    case V3Telemetry.MAGNET_HEALTH: {
      const value = decodeMagnetHealth(d);
      return value ? { kind: 'health', num, value } : { kind: 'malformed', num };
    }
    case V3Telemetry.DEVICE_UID: {
      const uid = decodeDeviceUid(d);
      return uid === null ? { kind: 'malformed', num } : { kind: 'uid', num, uid };
    }
    case V3Telemetry.COMMAND_ACK: {
      const ack = decodeCommandAck(d);
      return ack ? { kind: 'ack', num, ack } : { kind: 'malformed', num };
    }
    default:
      return { kind: 'malformed', num };
  }
}
