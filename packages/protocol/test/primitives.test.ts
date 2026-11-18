import { describe, expect, it } from 'vitest';
import {
  bitsToF32,
  crc32,
  crc32Update,
  decodeName,
  decodeUtf8,
  deriveUid,
  dlcToLength,
  encodeAscii,
  encodeName,
  encodeUtf8,
  enumDelayMs,
  f32ToBits,
  fdRoundUp,
  fnv1a64,
  fromHex,
  hash10,
  isValidFdLength,
  lengthToDlc,
  readF32,
  readI16,
  readI24,
  readI32,
  readU16,
  readU24,
  readU32,
  readU48,
  toHex,
  uid16,
  writeF32,
  writeU16,
  writeU24,
  writeU32,
  writeU48,
} from '../src';

const ascii = (s: string) => encodeAscii(s, s.length);

describe('little-endian helpers', () => {
  it('round-trips integer widths including sign extension', () => {
    const b = new Uint8Array(8);
    writeU16(b, 0, 0xbeef);
    expect(toHex(b.subarray(0, 2))).toBe('efbe');
    expect(readU16(b, 0)).toBe(0xbeef);
    expect(readI16(b, 0)).toBe(0xbeef - 0x10000);
    writeU24(b, 2, 0x800001);
    expect(readU24(b, 2)).toBe(0x800001);
    expect(readI24(b, 2)).toBe(0x800001 - 0x1000000);
    writeU32(b, 4, 0xfffffffe);
    expect(readU32(b, 4)).toBe(0xfffffffe);
    expect(readI32(b, 4)).toBe(-2);
    writeU32(b, 4, -1);
    expect(readU32(b, 4)).toBe(0xffffffff);
  });

  it('reads 48-bit values exactly', () => {
    const b = new Uint8Array(6);
    writeU48(b, 0, 0xfedcba987654);
    expect(toHex(b)).toBe('547698badcfe');
    expect(readU48(b, 0)).toBe(0xfedcba987654);
  });

  it('encodes f32 as IEEE-754 little-endian', () => {
    const b = new Uint8Array(4);
    writeF32(b, 0, 1.5);
    expect(toHex(b)).toBe('0000c03f');
    expect(readF32(b, 0)).toBe(1.5);
    expect(f32ToBits(-2)).toBe(0xc0000000);
    expect(bitsToF32(0x3f800000)).toBe(1);
    writeF32(b, 0, Number.NaN);
    expect(Number.isNaN(readF32(b, 0))).toBe(true);
  });

  it('hex helpers reject malformed input', () => {
    expect(fromHex('0a ff')).toEqual(Uint8Array.of(10, 255));
    expect(fromHex('abc')).toBeNull();
    expect(fromHex('zz')).toBeNull();
  });
});

describe('crc32 (IEEE)', () => {
  it('matches the standard check value', () => {
    expect(crc32(ascii('123456789'))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array(0))).toBe(0);
  });
  it('can be computed incrementally', () => {
    const d = ascii('123456789');
    expect(crc32Update(crc32(d, 0, 4), d, 4)).toBe(0xcbf43926);
  });
});

describe('FNV-1a-64 and UID derivation', () => {
  it('matches published FNV-1a-64 values', () => {
    expect(fnv1a64(new Uint8Array(0))).toBe(0xcbf29ce484222325n);
    expect(fnv1a64(ascii('a'))).toBe(0xaf63dc4c8601ec8cn);
    expect(fnv1a64(ascii('foobar'))).toBe(0x85944171f73967e8n);
  });

  // Reference values computed independently (Python, 64-bit integer FNV-1a).
  it.each([
    ['000102030405060708090a0b', 0x4819416d7fb9, 32697, 365, 64],
    ['20003a001251333038373439', 0x07ac04e44e33, 20019, 228, 97],
    ['ffffffffffffffffffffffff', 0x30ad34fe6de9, 28137, 254, 17],
  ])('derives uid48/uid16/hash10/delay for %s', (hex, u48, u16, h10, delay) => {
    const d = deriveUid(fromHex(hex)!);
    expect(d).toEqual({ uid48: u48, uid16: u16, hash10: h10, enumDelayMs: delay });
  });

  it('derivations use the documented bit ranges', () => {
    const u = 0xffff_ffff_ffff;
    expect(uid16(u)).toBe(0xffff);
    expect(hash10(u)).toBe(0x3ff);
    expect(enumDelayMs(u)).toBe((2 ** 22 - 1) % 100);
    expect(hash10(0x0000_0001_0000)).toBe(1);
    expect(enumDelayMs(0x4000000 * 105)).toBe(5);
  });
});

describe('CAN-FD lengths', () => {
  it('maps DLC codes and rounds lengths up', () => {
    expect([9, 10, 11, 12, 13, 14, 15].map(dlcToLength)).toEqual([12, 16, 20, 24, 32, 48, 64]);
    expect(lengthToDlc(8)).toBe(8);
    expect(lengthToDlc(9)).toBe(9);
    expect(lengthToDlc(33)).toBe(14);
    expect(lengthToDlc(65)).toBe(-1);
    expect(fdRoundUp(28)).toBe(32);
    expect(fdRoundUp(64)).toBe(64);
    expect(isValidFdLength(20)).toBe(true);
    expect(isValidFdLength(21)).toBe(false);
  });
});

describe('text', () => {
  it('UTF-8 round-trips Turkish and astral characters', () => {
    const s = 'Çağrı ışık ğüşöç İ 🚀';
    expect(decodeUtf8(encodeUtf8(s))).toBe(s);
  });
  it('replaces malformed sequences instead of throwing', () => {
    expect(decodeUtf8(Uint8Array.of(0x41, 0xc3, 0x42))).toBe('A�B');
    expect(decodeUtf8(Uint8Array.of(0xe2, 0x82))).toBe('�');
  });
  it('board names are 21 bytes, zero padded, cut on a character boundary', () => {
    const n = encodeName('Sol ön itici');
    expect(n.length).toBe(21);
    expect(decodeName(n)).toBe('Sol ön itici');
    const long = encodeName('ğğğğğğğğğğğ'); // 11 × 2 bytes = 22 > 21
    expect(decodeName(long)).toBe('ğğğğğğğğğğ');
    expect(long[20]).toBe(0);
  });
});
