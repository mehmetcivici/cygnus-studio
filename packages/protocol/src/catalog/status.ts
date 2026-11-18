import { readF32, readI16, readI24, readI32, readI8, readU16, readU24, readU32, writeF32, writeU16, writeU24, writeU32 } from '../core/bytes';
import type { StatusFieldDef, StatusFieldType, StatusFrameDef } from './schema';

export const STATUS_FRAME_BYTES = 8;

export const FIELD_SIZE: Readonly<Record<StatusFieldType, number>> = {
  u8: 1,
  i8: 1,
  u16: 2,
  i16: 2,
  u24: 3,
  i24: 3,
  u32: 4,
  i32: 4,
  f32: 4,
};

const SIGNED: Readonly<Record<StatusFieldType, boolean>> = {
  u8: false,
  i8: true,
  u16: false,
  i16: true,
  u24: false,
  i24: true,
  u32: false,
  i32: true,
  f32: true,
};

function readInt(t: StatusFieldType, d: Uint8Array, o: number): number {
  switch (t) {
    case 'u8':
      return d[o] ?? 0;
    case 'i8':
      return readI8(d, o);
    case 'u16':
      return readU16(d, o);
    case 'i16':
      return readI16(d, o);
    case 'u24':
      return readU24(d, o);
    case 'i24':
      return readI24(d, o);
    case 'u32':
      return readU32(d, o);
    default:
      return readI32(d, o);
  }
}

function writeInt(size: number, d: Uint8Array, o: number, v: number): void {
  if (size === 1) d[o] = v & 0xff;
  else if (size === 2) writeU16(d, o, v);
  else if (size === 3) writeU24(d, o, v);
  else writeU32(d, o, v);
}

/** Raw integer range a field can carry (bit fields are unsigned). */
export function fieldRawRange(f: StatusFieldDef): [number, number] {
  const width = f.bits ?? FIELD_SIZE[f.type] * 8;
  if (f.bits === undefined && SIGNED[f.type]) return [-(2 ** (width - 1)), 2 ** (width - 1) - 1];
  return [0, 2 ** width - 1];
}

/** Bytes a frame layout needs (the frame itself is always sent as 8 bytes). */
export function statusFrameLength(frame: StatusFrameDef): number {
  let n = 0;
  for (const f of frame.fields) n = Math.max(n, f.byte + FIELD_SIZE[f.type]);
  return n;
}

function decodeField(f: StatusFieldDef, d: Uint8Array): number {
  if (f.type === 'f32') return readF32(d, f.byte);
  let raw = readInt(f.type, d, f.byte);
  if (f.bits !== undefined) {
    // Bit fields are read from the unsigned container; `>>> 0` keeps u32 containers positive.
    raw = Math.floor((raw >>> 0) / 2 ** (f.bit ?? 0)) % 2 ** f.bits;
  }
  return raw * (f.scale ?? 1) + (f.bias ?? 0);
}

/**
 * Physical values → 8-byte STATUS payload. Values are scaled, rounded and saturated to the
 * field range; missing or non-finite values encode as raw 0.
 */
export function encodeStatusFrame(frame: StatusFrameDef, values: Readonly<Record<string, number>>): Uint8Array {
  const d = new Uint8Array(STATUS_FRAME_BYTES);
  for (const f of frame.fields) {
    const v = values[f.signal];
    if (f.type === 'f32') {
      writeF32(d, f.byte, v ?? 0);
      continue;
    }
    let raw = v === undefined || !Number.isFinite(v) ? 0 : Math.round((v - (f.bias ?? 0)) / (f.scale ?? 1));
    const [lo, hi] = fieldRawRange(f);
    raw = Math.min(hi, Math.max(lo, raw));
    const size = FIELD_SIZE[f.type];
    if (f.bits !== undefined) {
      const shift = 2 ** (f.bit ?? 0);
      const container = readInt(f.type, d, f.byte) >>> 0;
      // Arithmetic instead of bit ops so 32-bit containers stay exact.
      const cleared = container - (Math.floor(container / shift) % 2 ** f.bits) * shift;
      writeInt(size, d, f.byte, cleared + raw * shift);
    } else {
      writeInt(size, d, f.byte, raw);
    }
  }
  return d;
}

/** Writes decoded physical values into `out`; returns false when the payload is too short. */
export function decodeStatusFrameInto(frame: StatusFrameDef, data: Uint8Array, out: Record<string, number>): boolean {
  if (data.length < statusFrameLength(frame)) return false;
  for (const f of frame.fields) out[f.signal] = decodeField(f, data);
  return true;
}

export function decodeStatusFrame(frame: StatusFrameDef, data: Uint8Array): Record<string, number> | null {
  const out: Record<string, number> = {};
  return decodeStatusFrameInto(frame, data, out) ? out : null;
}
