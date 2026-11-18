import { readU16, readU32, writeU16, writeU32 } from './bytes';
import { crc32 } from './crc32';
import { decodeAscii, encodeAscii } from './text';

// .cyfw firmware image: 64-byte little-endian header + payload (PROTOCOL §9.1).

export const CYFW_MAGIC = 'CYFW';
export const CYFW_HEADER_SIZE = 64;
export const CYFW_HEADER_VERSION = 1;
export const CYFW_NAME_BYTES = 24;

export interface CyfwMeta {
  model: number;
  hwRevMin: number;
  hwRevMax: number;
  fwMajor: number;
  fwMinor: number;
  fwPatch: number;
  catalogRev: number;
  gitHash: number;
  /** Days since 2026-01-01. */
  buildDay: number;
  /** Printable ASCII, at most 24 characters. */
  name: string;
}

export interface CyfwHeader extends CyfwMeta {
  headerVer: number;
  payloadSize: number;
  payloadCrc32: number;
  headerCrc32: number;
}

export function encodeCyfwHeader(h: CyfwMeta & { payloadSize: number; payloadCrc32: number; headerVer?: number }): Uint8Array {
  const b = new Uint8Array(CYFW_HEADER_SIZE);
  for (let i = 0; i < 4; i++) b[i] = CYFW_MAGIC.charCodeAt(i);
  writeU16(b, 4, h.headerVer ?? CYFW_HEADER_VERSION);
  b[6] = h.model & 0xff;
  b[7] = h.hwRevMin & 0xff;
  b[8] = h.hwRevMax & 0xff;
  b[9] = h.fwMajor & 0xff;
  b[10] = h.fwMinor & 0xff;
  b[11] = h.fwPatch & 0xff;
  writeU32(b, 12, h.payloadSize);
  writeU32(b, 16, h.payloadCrc32);
  writeU16(b, 20, h.catalogRev);
  writeU32(b, 24, h.gitHash);
  writeU16(b, 28, h.buildDay);
  b.set(encodeAscii(h.name, CYFW_NAME_BYTES), 32);
  writeU32(b, 60, crc32(b, 0, 60));
  return b;
}

/** Parses the header fields; null if shorter than 64 bytes or the magic is wrong. Does not check CRCs. */
export function decodeCyfwHeader(b: Uint8Array): CyfwHeader | null {
  if (b.length < CYFW_HEADER_SIZE) return null;
  for (let i = 0; i < 4; i++) if (b[i] !== CYFW_MAGIC.charCodeAt(i)) return null;
  return {
    headerVer: readU16(b, 4),
    model: b[6] ?? 0,
    hwRevMin: b[7] ?? 0,
    hwRevMax: b[8] ?? 0,
    fwMajor: b[9] ?? 0,
    fwMinor: b[10] ?? 0,
    fwPatch: b[11] ?? 0,
    payloadSize: readU32(b, 12),
    payloadCrc32: readU32(b, 16),
    catalogRev: readU16(b, 20),
    gitHash: readU32(b, 24),
    buildDay: readU16(b, 28),
    name: decodeAscii(b, 32, 32 + CYFW_NAME_BYTES),
    headerCrc32: readU32(b, 60),
  };
}

export type CyfwError =
  | 'too_short'
  | 'bad_magic'
  | 'bad_header_version'
  | 'bad_header_crc'
  | 'size_mismatch'
  | 'bad_payload_crc'
  | 'wrong_model'
  | 'wrong_hw_rev';

export type CyfwValidation =
  | { ok: true; header: CyfwHeader; payload: Uint8Array; fileCrc32: number }
  | { ok: false; error: CyfwError; header: CyfwHeader | null };

/**
 * Full image check, in the order a bootloader would do it. With `target`, also checks that
 * the image is meant for that model / hardware revision (the board answers BAD_IMAGE otherwise).
 */
export function validateCyfw(file: Uint8Array, target?: { model: number; hwRev?: number }): CyfwValidation {
  if (file.length < CYFW_HEADER_SIZE) return { ok: false, error: 'too_short', header: null };
  const header = decodeCyfwHeader(file);
  if (!header) return { ok: false, error: 'bad_magic', header: null };
  if (header.headerVer !== CYFW_HEADER_VERSION) return { ok: false, error: 'bad_header_version', header };
  if (crc32(file, 0, 60) !== header.headerCrc32) return { ok: false, error: 'bad_header_crc', header };
  if (file.length !== CYFW_HEADER_SIZE + header.payloadSize) return { ok: false, error: 'size_mismatch', header };
  const payload = file.subarray(CYFW_HEADER_SIZE);
  if (crc32(payload) !== header.payloadCrc32) return { ok: false, error: 'bad_payload_crc', header };
  if (target) {
    if (target.model !== header.model) return { ok: false, error: 'wrong_model', header };
    if (target.hwRev !== undefined && (target.hwRev < header.hwRevMin || target.hwRev > header.hwRevMax)) {
      return { ok: false, error: 'wrong_hw_rev', header };
    }
  }
  return { ok: true, header, payload, fileCrc32: crc32(file) };
}

/** Builds a complete .cyfw image (header with computed size/CRCs + payload). */
export function buildCyfw(meta: CyfwMeta, payload: Uint8Array): Uint8Array {
  const header = encodeCyfwHeader({ ...meta, payloadSize: payload.length, payloadCrc32: crc32(payload) });
  const out = new Uint8Array(CYFW_HEADER_SIZE + payload.length);
  out.set(header, 0);
  out.set(payload, CYFW_HEADER_SIZE);
  return out;
}
