import { describe, expect, it } from 'vitest';
import { CYFW_HEADER_SIZE, buildCyfw, crc32, decodeCyfwHeader, encodeCyfwHeader, readU32, toHex, validateCyfw, type CyfwMeta } from '../src';

const meta: CyfwMeta = {
  model: 1,
  hwRevMin: 2,
  hwRevMax: 4,
  fwMajor: 1,
  fwMinor: 2,
  fwPatch: 3,
  catalogRev: 7,
  gitHash: 0xa1b2c3d4,
  buildDay: 42,
  name: 'esc20a-1.2.3',
};
const payload = Uint8Array.from({ length: 1000 }, (_, i) => (i * 7) & 0xff);

describe('.cyfw', () => {
  it('lays out the 64-byte header as documented', () => {
    const h = encodeCyfwHeader({ ...meta, payloadSize: 1000, payloadCrc32: 0x11223344 });
    expect(h.length).toBe(64);
    expect(toHex(h.subarray(0, 12))).toBe('4359465701000102040102' + '03');
    expect(toHex(h.subarray(12, 20))).toBe('e803000044332211');
    expect(toHex(h.subarray(20, 32))).toBe('07000000d4c3b2a12a000000');
    expect(String.fromCharCode(...h.subarray(32, 44))).toBe('esc20a-1.2.3');
    expect(h[44]).toBe(0);
    expect(readU32(h, 60)).toBe(crc32(h, 0, 60));
  });

  it('builds and validates an image', () => {
    const file = buildCyfw(meta, payload);
    expect(file.length).toBe(CYFW_HEADER_SIZE + payload.length);
    const v = validateCyfw(file, { model: 1, hwRev: 3 });
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.header).toMatchObject({ ...meta, headerVer: 1, payloadSize: 1000, payloadCrc32: crc32(payload) });
      expect(v.payload).toEqual(payload);
      expect(v.fileCrc32).toBe(crc32(file));
    }
    expect(decodeCyfwHeader(file)?.name).toBe('esc20a-1.2.3');
  });

  it('reports each failure', () => {
    const file = buildCyfw(meta, payload);
    const mutate = (fn: (b: Uint8Array) => void) => {
      const b = file.slice();
      fn(b);
      return b;
    };
    expect(validateCyfw(file.subarray(0, 10))).toMatchObject({ ok: false, error: 'too_short' });
    expect(validateCyfw(mutate((b) => (b[0] = 0x58)))).toMatchObject({ ok: false, error: 'bad_magic' });
    expect(validateCyfw(mutate((b) => (b[33] = (b[33] ?? 0) ^ 1)))).toMatchObject({ ok: false, error: 'bad_header_crc' });
    expect(validateCyfw(mutate((b) => (b[100] = (b[100] ?? 0) ^ 1)))).toMatchObject({ ok: false, error: 'bad_payload_crc' });
    expect(validateCyfw(file.subarray(0, file.length - 1))).toMatchObject({ ok: false, error: 'size_mismatch' });
    expect(validateCyfw(file, { model: 2 })).toMatchObject({ ok: false, error: 'wrong_model' });
    expect(validateCyfw(file, { model: 1, hwRev: 5 })).toMatchObject({ ok: false, error: 'wrong_hw_rev' });
    const v2 = encodeCyfwHeader({ ...meta, payloadSize: 0, payloadCrc32: 0, headerVer: 2 });
    expect(validateCyfw(v2)).toMatchObject({ ok: false, error: 'bad_header_version' });
  });
});
