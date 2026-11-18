// Little-endian field access on plain Uint8Arrays. Hot decode paths call these per frame,
// so they avoid DataView allocation and use one shared scratch buffer for f32.

const scratch = new ArrayBuffer(4);
const scratchF32 = new Float32Array(scratch);
const scratchU8 = new Uint8Array(scratch);
const hostLittleEndian = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

export function readU8(b: Uint8Array, o: number): number {
  return b[o] ?? 0;
}

export function readI8(b: Uint8Array, o: number): number {
  return ((b[o] ?? 0) << 24) >> 24;
}

export function readU16(b: Uint8Array, o: number): number {
  return (b[o] ?? 0) | ((b[o + 1] ?? 0) << 8);
}

export function readI16(b: Uint8Array, o: number): number {
  return (readU16(b, o) << 16) >> 16;
}

export function readU24(b: Uint8Array, o: number): number {
  return (b[o] ?? 0) | ((b[o + 1] ?? 0) << 8) | ((b[o + 2] ?? 0) << 16);
}

export function readI24(b: Uint8Array, o: number): number {
  return (readU24(b, o) << 8) >> 8;
}

export function readU32(b: Uint8Array, o: number): number {
  return ((b[o] ?? 0) | ((b[o + 1] ?? 0) << 8) | ((b[o + 2] ?? 0) << 16) | ((b[o + 3] ?? 0) << 24)) >>> 0;
}

export function readI32(b: Uint8Array, o: number): number {
  return (b[o] ?? 0) | ((b[o + 1] ?? 0) << 8) | ((b[o + 2] ?? 0) << 16) | ((b[o + 3] ?? 0) << 24);
}

export function readF32(b: Uint8Array, o: number): number {
  if (hostLittleEndian) {
    scratchU8[0] = b[o] ?? 0;
    scratchU8[1] = b[o + 1] ?? 0;
    scratchU8[2] = b[o + 2] ?? 0;
    scratchU8[3] = b[o + 3] ?? 0;
  } else {
    scratchU8[3] = b[o] ?? 0;
    scratchU8[2] = b[o + 1] ?? 0;
    scratchU8[1] = b[o + 2] ?? 0;
    scratchU8[0] = b[o + 3] ?? 0;
  }
  return scratchF32[0] ?? 0;
}

export function writeU8(b: Uint8Array, o: number, v: number): void {
  b[o] = v & 0xff;
}

export function writeU16(b: Uint8Array, o: number, v: number): void {
  b[o] = v & 0xff;
  b[o + 1] = (v >>> 8) & 0xff;
}

export function writeU24(b: Uint8Array, o: number, v: number): void {
  b[o] = v & 0xff;
  b[o + 1] = (v >>> 8) & 0xff;
  b[o + 2] = (v >>> 16) & 0xff;
}

/** Writes the low 32 bits; works for both signed and unsigned inputs. */
export function writeU32(b: Uint8Array, o: number, v: number): void {
  b[o] = v & 0xff;
  b[o + 1] = (v >>> 8) & 0xff;
  b[o + 2] = (v >>> 16) & 0xff;
  b[o + 3] = (v >>> 24) & 0xff;
}

export function writeF32(b: Uint8Array, o: number, v: number): void {
  scratchF32[0] = v;
  if (hostLittleEndian) {
    b[o] = scratchU8[0] ?? 0;
    b[o + 1] = scratchU8[1] ?? 0;
    b[o + 2] = scratchU8[2] ?? 0;
    b[o + 3] = scratchU8[3] ?? 0;
  } else {
    b[o] = scratchU8[3] ?? 0;
    b[o + 1] = scratchU8[2] ?? 0;
    b[o + 2] = scratchU8[1] ?? 0;
    b[o + 3] = scratchU8[0] ?? 0;
  }
}

/** IEEE-754 single bit pattern of `v` as an unsigned 32-bit integer. */
export function f32ToBits(v: number): number {
  scratchF32[0] = v;
  return readU32(scratchU8, 0) >>> 0;
}

export function bitsToF32(bits: number): number {
  writeU32(scratchU8, 0, bits);
  return scratchF32[0] ?? 0;
}

/** 48-bit unsigned (UID) little-endian; values stay exact as JS numbers. */
export function readU48(b: Uint8Array, o: number): number {
  return readU32(b, o) + readU16(b, o + 4) * 0x1_0000_0000;
}

export function writeU48(b: Uint8Array, o: number, v: number): void {
  writeU32(b, o, v % 0x1_0000_0000);
  writeU16(b, o + 4, Math.floor(v / 0x1_0000_0000));
}

const HEX = '0123456789abcdef';

export function toHex(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) {
    const v = b[i] ?? 0;
    s += HEX[v >> 4]! + HEX[v & 15]!;
  }
  return s;
}

/** Parses an even-length hex string (whitespace ignored); returns null on bad input. */
export function fromHex(hex: string): Uint8Array | null {
  const s = hex.replace(/\s+/g, '');
  if (s.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(s)) return null;
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
