import { PType } from '../core/constants';
import { readParamValue, writeParamValue } from '../core/messages';
import type { ParamDef } from './schema';

export type ParamCheck =
  | 'ok'
  | 'not_number'
  | 'not_integer'
  | 'out_of_range'
  | 'below_min_nonzero'
  | 'invalid_option'
  | 'read_only';

/** The value the board will actually hold after a SET (f32 rounding, integer rounding). */
export function quantizeParamValue(def: ParamDef, value: number): number {
  switch (def.ptype) {
    case PType.F32:
      return Math.fround(value);
    case PType.BOOL:
      return value ? 1 : 0;
    case PType.I32:
      return Math.round(value) | 0;
    default:
      return Math.round(value) >>> 0;
  }
}

/**
 * Host-side validation before sending a SET. Mirrors the board's OUT_OF_RANGE /
 * READ_ONLY decisions; pass `allowReadOnly` when checking values read from a board.
 */
export function checkParamValue(def: ParamDef, value: number, opts: { allowReadOnly?: boolean } = {}): ParamCheck {
  if (def.readOnly && !opts.allowReadOnly) return 'read_only';
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'not_number';
  if (def.ptype === PType.F32) {
    const v = Math.fround(value);
    if (v < Math.fround(def.min) || v > Math.fround(def.max)) return 'out_of_range';
  } else {
    if (!Number.isInteger(value)) return 'not_integer';
    if (def.ptype === PType.BOOL && value !== 0 && value !== 1) return 'out_of_range';
    if (def.ptype === PType.ENUM) {
      return def.options?.some((o) => o.value === value) ? 'ok' : 'invalid_option';
    }
    if (value < def.min || value > def.max) return 'out_of_range';
  }
  if (def.minNonZero !== undefined && value !== 0 && Math.abs(value) < def.minNonZero) return 'below_min_nonzero';
  return 'ok';
}

/** Clamps into [min, max] and onto the minNonZero rule; enum/bool values snap to the default if invalid. */
export function clampParamValue(def: ParamDef, value: number): number {
  if (!Number.isFinite(value)) return def.default;
  if (def.ptype === PType.ENUM) return def.options?.some((o) => o.value === value) ? value : def.default;
  if (def.ptype === PType.BOOL) return value ? 1 : 0;
  let v = Math.min(def.max, Math.max(def.min, value));
  if (def.minNonZero !== undefined && v !== 0 && Math.abs(v) < def.minNonZero) v = Math.sign(v) * def.minNonZero;
  return quantizeParamValue(def, v);
}

/** 4-byte little-endian wire form of a parameter value. */
export function encodeParamBytes(def: ParamDef, value: number): Uint8Array {
  const b = new Uint8Array(4);
  writeParamValue(def.ptype, value, b, 0);
  return b;
}

export function decodeParamBytes(def: ParamDef, bytes: Uint8Array, offset = 0): number {
  return readParamValue(def.ptype, bytes, offset);
}
