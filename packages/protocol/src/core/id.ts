import { Cls, DevType, LEGACY_CLASS_MAX, MFR } from './constants';
import type { Address } from './frame';

/*
 * 29-bit identifier layout (FRC compatible):
 *   28..24 DEVTYPE · 23..16 MFR · 15..10 CLASS · 9..6 INDEX · 5..0 NUM
 */

export const ID_MASK = 0x1fffffff;

export interface CanIdFields {
  devType: number;
  mfr: number;
  cls: number;
  index: number;
  num: number;
}

export function encodeId(f: { devType: number; cls: number; index: number; num: number; mfr?: number }): number {
  const mfr = f.mfr ?? MFR;
  return (
    (((f.devType & 0x1f) << 24) | ((mfr & 0xff) << 16) | ((f.cls & 0x3f) << 10) | ((f.index & 0x0f) << 6) | (f.num & 0x3f)) >>>
    0
  );
}

export function decodeId(id: number): CanIdFields {
  return {
    devType: (id >>> 24) & 0x1f,
    mfr: (id >>> 16) & 0xff,
    cls: (id >>> 10) & 0x3f,
    index: (id >>> 6) & 0x0f,
    num: id & 0x3f,
  };
}

// Allocation-free field accessors for hot receive paths.
export const idDevType = (id: number): number => (id >>> 24) & 0x1f;
export const idMfr = (id: number): number => (id >>> 16) & 0xff;
export const idClass = (id: number): number => (id >>> 10) & 0x3f;
export const idIndex = (id: number): number => (id >>> 6) & 0x0f;
export const idNum = (id: number): number => id & 0x3f;
/** Low 10 bits (INDEX + NUM); carries `hash10` in ENUM_RSP frames. */
export const idLow10 = (id: number): number => id & 0x3ff;

export function messageId(addr: Address, cls: number, index: number): number {
  return encodeId({ devType: addr.devType, cls, index, num: addr.num });
}

/** ENUM_RSP id: the INDEX+NUM field carries hash10 so same-number boards still differ. */
export function encodeEnumRspId(devType: number, hash10: number): number {
  return encodeId({ devType, cls: Cls.ENUM_RSP, index: (hash10 >>> 6) & 0x0f, num: hash10 & 0x3f });
}

/** True for any CyCAN frame (our MFR and a class outside the legacy Cyncoder v3 range). */
export function isCyCanId(id: number): boolean {
  return idMfr(id) === MFR && idClass(id) > LEGACY_CLASS_MAX;
}

/** Even classes travel host to board. */
export function isToDeviceClass(cls: number): boolean {
  return (cls & 1) === 0;
}

/**
 * Board-side acceptance rule (PROTOCOL §2.2): MFR matches and the class is a CyCAN
 * host-to-board class, and either (DEVTYPE is ours and NUM is ours or 0) or
 * (DEVTYPE 0 and NUM 0). Frames sent by other boards (odd classes) are never "accepted";
 * conflict detection inspects them separately.
 */
export function acceptsFrame(id: number, devType: number, num: number): boolean {
  if (id > ID_MASK || id < 0) return false;
  if (idMfr(id) !== MFR) return false;
  const cls = idClass(id);
  if (cls <= LEGACY_CLASS_MAX || !isToDeviceClass(cls)) return false;
  const dt = idDevType(id);
  const n = idNum(id);
  if (dt === devType) return n === num || n === 0;
  return dt === DevType.BROADCAST && n === 0;
}
