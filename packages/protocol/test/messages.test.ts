import { describe, expect, it } from 'vitest';
import {
  BROADCAST_ALL,
  Cls,
  decodeCtrlServo,
  decodeCtrlSet,
  decodeCtrlText,
  decodeEstop,
  decodeIdentify,
  decodeMessage,
  decodeStreamData,
  encodeCtrlText,
  encodeEstop,
  encodeFwData,
  encodeHeartbeat,
  encodeId,
  encodeIdentify,
  encodeMessage,
  encodeStreamData,
  hash10,
  idIndex,
  idLow10,
  idNum,
  streamDataCount,
  streamDataValue,
  toHex,
  uid96FromInfoPages,
  uid96ToInfoPages,
  type CyCanMessage,
} from '../src';
import { MESSAGE_CASES } from './vectors/cases';

function decodeAny(id: number, data: Uint8Array, kind: CyCanMessage['kind']): CyCanMessage | null {
  switch (kind) {
    case 'ctrlSet':
      return decodeCtrlSet(data);
    case 'ctrlServo':
      return decodeCtrlServo(data, idIndex(id));
    case 'ctrlText':
      return decodeCtrlText(data);
    default:
      return decodeMessage(id, data);
  }
}

describe('message codecs round-trip', () => {
  it.each(MESSAGE_CASES.map((c) => [c.name, c] as const))('%s', (_n, c) => {
    const f = encodeMessage(c.addr, c.msg);
    expect(f.fd).toBe(f.data.length > 8);
    expect(decodeAny(f.id, f.data, c.msg.kind)).toEqual(c.msg);
  });

  it('every message kind has at least one case', () => {
    const kinds = new Set(MESSAGE_CASES.map((c) => c.msg.kind));
    for (const k of [
      'enumReq', 'assignId', 'identify', 'identifyUid', 'infoReq', 'nameSet', 'command', 'faultReq', 'estop',
      'heartbeat', 'infoRsp', 'commandRsp', 'faultRsp', 'enumRsp', 'paramGet', 'paramSet', 'paramValue',
      'streamConfig', 'streamStart', 'streamStop', 'streamData', 'fwBegin', 'fwData', 'fwEnd', 'fwAck',
      'ctrlSet', 'ctrlServo', 'ctrlText',
    ]) expect(kinds.has(k as CyCanMessage['kind'])).toBe(true);
  });
});

describe('short payloads return null instead of throwing', () => {
  it.each(MESSAGE_CASES.map((c) => [c.name, c] as const))('%s', (_n, c) => {
    const f = encodeMessage(c.addr, c.msg);
    for (let len = 0; len < f.data.length; len++) {
      const short = f.data.slice(0, len);
      expect(() => decodeAny(f.id, short, c.msg.kind)).not.toThrow();
    }
    // The empty payload must fail for every message that carries fields.
    const r = decodeAny(f.id, new Uint8Array(0), c.msg.kind);
    if (f.data.length > 0 && c.msg.kind !== 'faultReq') expect(r).toBeNull();
  });

  it('survives random payloads on every CyCAN class/index', () => {
    let seed = 12345;
    const rnd = () => (seed = (seed * 1103515245 + 12345) >>> 0) >>> 24;
    for (let cls = 0x10; cls <= 0x1b; cls++) {
      for (let index = 0; index < 16; index++) {
        for (let len = 0; len <= 64; len += 3) {
          const data = Uint8Array.from({ length: len }, rnd);
          expect(() => decodeMessage(encodeId({ devType: 2, cls, index, num: 1 }), data)).not.toThrow();
        }
      }
    }
  });
});

describe('message details', () => {
  it('heartbeat packs state and flags into byte 0', () => {
    const f = encodeHeartbeat({ devType: 2, num: 1 }, {
      state: 3, unsaved: true, enabled: true, warning: false, identify: true, fault: 0x0201, uid16: 0x1234, fwMajor: 1, fwMinor: 2, fwPatch: 3,
    });
    expect(toHex(f.data)).toBe('b30102341201' + '0203');
  });

  it('ENUM_RSP id low bits are hash10(uid48), independent of NUM', () => {
    const f = encodeMessage({ devType: 2, num: 9 }, { kind: 'enumRsp', uid48: 0x4819416d7fb9, num: 9, conflict: false, bootloader: false, model: 1 });
    expect(idLow10(f.id)).toBe(hash10(0x4819416d7fb9));
    expect(idLow10(f.id)).toBe(365);
  });

  it('IDENTIFY forms are told apart by length', () => {
    expect(decodeIdentify(Uint8Array.of(3))).toEqual({ kind: 'identify', seconds: 3 });
    const f = encodeMessage(BROADCAST_ALL, { kind: 'identifyUid', uid48: 1, seconds: 2 });
    expect(f.data.length).toBe(7);
    expect(decodeIdentify(f.data)).toEqual({ kind: 'identifyUid', uid48: 1, seconds: 2 });
    expect(encodeIdentify({ devType: 2, num: 1 }, { seconds: 0 }).data.length).toBe(1);
  });

  it('ESTOP requires the magic bytes', () => {
    expect(toHex(encodeEstop(BROADCAST_ALL).data)).toBe('e570');
    expect(decodeEstop(Uint8Array.of(0xe5, 0x71))).toBeNull();
    expect(decodeEstop(Uint8Array.of(0xe5))).toBeNull();
  });

  it('stream DATA: classic single slot, FD multi-slot with padding', () => {
    const one = encodeStreamData({ devType: 2, num: 1 }, { seq: 1, firstSlot: 4, t100us: 9, values: [2.5] });
    expect(one.fd).toBe(false);
    expect(one.data.length).toBe(8);
    expect(streamDataCount(one.data)).toBe(1);
    expect(streamDataValue(one.data, 0)).toBe(2.5);

    const six = encodeStreamData({ devType: 2, num: 1 }, { seq: 1, firstSlot: 0, t100us: 9, values: [1, 2, 3, 4, 5, 6] });
    expect(six.fd).toBe(true);
    expect(six.brs).toBe(true);
    expect(six.data.length).toBe(32); // 28 rounded up to the next FD length
    expect(decodeStreamData(six.data)?.values).toEqual([1, 2, 3, 4, 5, 6, 0]);

    // Values never run past slot 14 even if the payload is longer.
    const tail = new Uint8Array(64);
    tail[1] = 12;
    expect(streamDataCount(tail)).toBe(3);
    tail[1] = 15;
    expect(decodeStreamData(tail)).toBeNull();
    expect(() => encodeStreamData(BROADCAST_ALL, { seq: 0, firstSlot: 14, t100us: 0, values: [1, 2] })).toThrow(RangeError);
  });

  it('FW DATA: 5-byte classic and 61-byte FD chunks fill their frames exactly', () => {
    expect(encodeFwData(BROADCAST_ALL, { offset: 0, bytes: new Uint8Array(5) }).data.length).toBe(8);
    const fd = encodeFwData(BROADCAST_ALL, { offset: 0xabcdef, bytes: new Uint8Array(61) });
    expect(fd.data.length).toBe(64);
    expect(toHex(fd.data.subarray(0, 3))).toBe('efcdab');
    expect(() => encodeFwData(BROADCAST_ALL, { offset: 0x1000000, bytes: new Uint8Array(5) })).toThrow(RangeError);
  });

  it('CTRL TEXT keeps printable ASCII and pads with NUL', () => {
    const f = encodeCtrlText({ devType: 10, num: 1 }, { line: 0, col: 0, text: 'Iş' });
    expect(toHex(f.data)).toBe('0000493f00000000');
    expect(decodeCtrlText(f.data)?.text).toBe('I?');
  });

  it('CTRL and STATUS decode as raw frames with their index', () => {
    const id = encodeId({ devType: 2, cls: Cls.STATUS, index: 3, num: 1 });
    const data = new Uint8Array(8);
    expect(decodeMessage(id, data)).toEqual({ kind: 'status', index: 3, data });
    expect(idNum(id)).toBe(1);
  });

  it('unknown indexes and non-CyCAN classes decode to null', () => {
    expect(decodeMessage(encodeId({ devType: 2, cls: Cls.SYS_RSP, index: 1, num: 1 }), new Uint8Array(8))).toBeNull();
    expect(decodeMessage(encodeId({ devType: 2, cls: 0x01, index: 0, num: 1 }), new Uint8Array(8))).toBeNull();
  });

  it('splits and joins the 96-bit UID across INFO pages 1 and 2', () => {
    const uid = Uint8Array.from({ length: 12 }, (_, i) => i + 1);
    const [p1, p2] = uid96ToInfoPages(uid);
    expect(toHex(p2)).toBe('08090a0b0c0000');
    expect(uid96FromInfoPages(p1, p2)).toEqual(uid);
  });
});
