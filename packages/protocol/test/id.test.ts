import { describe, expect, it } from 'vitest';
import { Cls, DevType, acceptsFrame, decodeId, encodeEnumRspId, encodeId, idClass, idLow10, isCyCanId } from '../src';

describe('29-bit id layout', () => {
  // Hand-computed: (devType << 24) | (8 << 16) | (cls << 10) | (index << 6) | num
  it.each([
    ['HEARTBEAT from ESC #1', { devType: 2, cls: 0x13, index: 0, num: 1 }, 0x02084c01],
    ['ENUM_REQ broadcast', { devType: 0, cls: 0x12, index: 0, num: 0 }, 0x00084800],
    ['ESTOP broadcast', { devType: 0, cls: 0x12, index: 7, num: 0 }, 0x000849c0],
    ['PARAM GET to Cyncoder #5', { devType: 7, cls: 0x14, index: 0, num: 5 }, 0x07085005],
    ['STATUS/15 from servo #62', { devType: 12, cls: 0x11, index: 15, num: 62 }, 0x0c0847fe],
  ])('%s', (_name, f, id) => {
    expect(encodeId(f)).toBe(id);
    expect(decodeId(id)).toEqual({ ...f, mfr: 8 });
  });

  it('ENUM_RSP carries hash10 in INDEX+NUM', () => {
    const id = encodeEnumRspId(DevType.ENCODER, 0x2a5);
    expect(id).toBe(0x07086ea5);
    expect(idClass(id)).toBe(Cls.ENUM_RSP);
    expect(idLow10(id)).toBe(0x2a5);
    const d = decodeId(id);
    expect(d.index).toBe(10);
    expect(d.num).toBe(37);
  });

  it('distinguishes CyCAN from legacy Cyncoder v3 and foreign MFR', () => {
    expect(isCyCanId(0x02084c01)).toBe(true);
    expect(isCyCanId(encodeId({ devType: 10, cls: 0, index: 0, num: 1 }))).toBe(false);
    expect(isCyCanId(encodeId({ devType: 2, cls: 0x13, index: 0, num: 1, mfr: 5 }))).toBe(false);
  });
});

describe('acceptsFrame', () => {
  const to = (devType: number, num: number, cls: number = Cls.PARAM_REQ) => encodeId({ devType, cls, index: 0, num });

  it('accepts own address, type broadcast and global broadcast', () => {
    expect(acceptsFrame(to(2, 5), 2, 5)).toBe(true);
    expect(acceptsFrame(to(2, 0), 2, 5)).toBe(true);
    expect(acceptsFrame(to(0, 0, Cls.SYS_REQ), 2, 5)).toBe(true);
  });

  it('rejects other numbers, other types and DEVTYPE 0 with a non-zero NUM', () => {
    expect(acceptsFrame(to(2, 6), 2, 5)).toBe(false);
    expect(acceptsFrame(to(7, 5), 2, 5)).toBe(false);
    expect(acceptsFrame(to(0, 5), 2, 5)).toBe(false);
  });

  it('rejects board-to-host classes, legacy classes, foreign MFR and out-of-range ids', () => {
    expect(acceptsFrame(to(2, 5, Cls.SYS_RSP), 2, 5)).toBe(false);
    expect(acceptsFrame(to(2, 5, Cls.ENUM_RSP), 2, 5)).toBe(false);
    expect(acceptsFrame(to(2, 5, 0x00), 2, 5)).toBe(false);
    expect(acceptsFrame(encodeId({ devType: 2, cls: Cls.CTRL, index: 0, num: 5, mfr: 9 }), 2, 5)).toBe(false);
    expect(acceptsFrame(0x20000000 | to(2, 5), 2, 5)).toBe(false);
  });

  it('unassigned boards (NUM 63) still get type and global broadcasts', () => {
    expect(acceptsFrame(to(2, 63), 2, 63)).toBe(true);
    expect(acceptsFrame(to(2, 0), 2, 63)).toBe(true);
  });
});
