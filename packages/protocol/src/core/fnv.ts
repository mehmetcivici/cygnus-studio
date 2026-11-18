// UID derivations (PROTOCOL §3.1). The firmware computes the same values with uint64 math;
// BigInt keeps the 64-bit multiply exact here. Called once per discovered board, not per frame.

const FNV64_OFFSET = 0xcbf29ce484222325n;
const FNV64_PRIME = 0x100000001b3n;
const MASK64 = 0xffffffffffffffffn;

export function fnv1a64(data: Uint8Array): bigint {
  let h = FNV64_OFFSET;
  for (let i = 0; i < data.length; i++) {
    h ^= BigInt(data[i] ?? 0);
    h = (h * FNV64_PRIME) & MASK64;
  }
  return h;
}

/** uid48 = FNV-1a-64(uid96 bytes) & 0xFFFF_FFFF_FFFF, as an exact JS number. */
export function uid48FromUid96(uid96: Uint8Array): number {
  return Number(fnv1a64(uid96) & 0xffffffffffffn);
}

export function uid16(uid48: number): number {
  return uid48 % 0x10000;
}

export function hash10(uid48: number): number {
  return Math.floor(uid48 / 0x10000) & 0x3ff;
}

/** ENUM_RSP reply delay in ms, 0..99. */
export function enumDelayMs(uid48: number): number {
  return Math.floor(uid48 / 0x400_0000) % 100;
}

export interface UidDerived {
  uid48: number;
  uid16: number;
  hash10: number;
  enumDelayMs: number;
}

export function deriveUid(uid96: Uint8Array): UidDerived {
  const u = uid48FromUid96(uid96);
  return { uid48: u, uid16: uid16(u), hash10: hash10(u), enumDelayMs: enumDelayMs(u) };
}
