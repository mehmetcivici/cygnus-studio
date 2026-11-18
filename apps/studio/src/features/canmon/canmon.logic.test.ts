import { describe, expect, it } from 'vitest';
import { Cls, DevType, encodeId, encodeEstop, encodeInfoReq, BROADCAST_ALL, type CanFrame } from '@cygnus/protocol';
import { FrameTrace } from '../../core/recorder/frames';
import { FrameAnnotator, RESPONSE_TIMEOUT_MS, expectedResponse, isErrorFrame } from './annotate';
import { IdAggregator, freqOf } from './aggregate';
import { EMPTY_FILTER, FLAG_ERROR, FLAG_UNANSWERED, cardOf, compileFilter, isFilterActive } from './filter';
import { candumpLine, fmtDelta, fmtFrameTime, toCandump, toCsv, csvRow } from './format';
import { classBucket, composeId, frameKind, idSegments, invalidFields, parseDataHex, parseHexId, parseSend, sendRisks } from './ids';
import { StreamIndex } from './streamIndex';

const dec = (v: number, d: number): string => v.toFixed(d);
const id = (devType: number, cls: number, index: number, num: number, mfr = 8): number => encodeId({ devType, cls, index, num, mfr });
const frame = (t: number, i: number, data: number[] = [], extra: Partial<CanFrame> = {}): CanFrame => ({ id: i, data: Uint8Array.from(data), fd: false, brs: false, timestamp: t, ...extra });

describe('identifier helpers', () => {
  it('composes and splits the 29-bit id', () => {
    const v = composeId({ devType: 2, mfr: 8, cls: 0x11, index: 3, num: 5 });
    expect(v).toBe(id(2, 0x11, 3, 5));
    expect(idSegments(v).map((s) => [s.key, s.value, s.bits])).toEqual([
      ['devType', 2, '00010'],
      ['mfr', 8, '00001000'],
      ['cls', 0x11, '010001'],
      ['index', 3, '0011'],
      ['num', 5, '000101'],
    ]);
    expect(idSegments(v)[0]).toMatchObject({ hi: 28, lo: 24 });
  });

  it('flags fields that do not fit their width', () => {
    expect(invalidFields({ devType: 32, mfr: 8, cls: 64, index: 16, num: 64 })).toEqual(['devType', 'cls', 'index', 'num']);
    expect(invalidFields({ devType: 31, mfr: 255, cls: 63, index: 15, num: 63 })).toEqual([]);
    expect(invalidFields({ devType: -1, mfr: 8, cls: 1.5, index: 0, num: 0 })).toEqual(['devType', 'cls']);
  });

  it('parses hex ids and payloads strictly', () => {
    expect(parseHexId('0x18080C41')).toBe(0x18080c41);
    expect(parseHexId('18 08 0c 41')).toBe(0x18080c41);
    expect(parseHexId('20000000')).toBeNull();
    expect(parseHexId('xyz')).toBeNull();
    expect(parseHexId('')).toBeNull();
    expect(Array.from(parseDataHex('01 0a FF') ?? [])).toEqual([1, 10, 255]);
    expect(Array.from(parseDataHex('0x01,0x02') ?? [])).toEqual([1, 2]);
    expect(parseDataHex('abc')).toBeNull();
    expect(parseDataHex('')?.length).toBe(0);
  });

  it('classifies frames', () => {
    expect(frameKind(id(2, 0x11, 0, 1))).toBe('cycan');
    expect(frameKind(id(10, 0x01, 0, 1))).toBe('legacy');
    expect(frameKind(id(2, 0x11, 0, 1, 5))).toBe('foreign');
    expect(classBucket(id(2, 0x11, 0, 1))).toBe(0x11);
    expect(classBucket(id(10, 0x01, 0, 1))).toBe(-1);
    expect(classBucket(id(2, 0x11, 0, 1, 5))).toBe(-2);
  });

  it('validates the raw send form', () => {
    expect(parseSend('18080C41', '', false, false)).toMatchObject({ ok: true });
    expect(parseSend('zz', '', false, false)).toEqual({ ok: false, error: 'badId' });
    expect(parseSend('1', '0', false, false)).toEqual({ ok: false, error: 'badData' });
    expect(parseSend('1', '000000000000000000', false, false)).toEqual({ ok: false, error: 'tooLong' });
    expect(parseSend('1', '0000000000000000000000', true, true)).toEqual({ ok: false, error: 'fdLength' });
    const fd = parseSend('1', '00'.repeat(12), true, true);
    expect(fd.ok && fd.frame).toMatchObject({ fd: true, brs: true });
    // BRS only exists in FD frames.
    const classic = parseSend('1', '00', false, true);
    expect(classic.ok && classic.frame.brs).toBe(false);
  });
});

describe('send risk', () => {
  it('needs confirmation for CTRL, non-ESTOP broadcast and foreign frames only', () => {
    expect(sendRisks(id(2, Cls.CTRL, 0, 3))).toEqual(['ctrl']);
    expect(sendRisks(id(2, Cls.CTRL, 0, 0))).toEqual(['ctrl', 'broadcast']);
    expect(sendRisks(id(0, Cls.SYS_REQ, 0, 0))).toEqual(['broadcast']); // ENUM_REQ
    expect(sendRisks(id(0, Cls.SYS_REQ, 7, 0))).toEqual([]); // ESTOP
    expect(sendRisks(id(2, Cls.SYS_REQ, 3, 4))).toEqual([]); // INFO_REQ to one board
    expect(sendRisks(id(2, Cls.PARAM_REQ, 0, 4))).toEqual([]);
    expect(sendRisks(id(2, 0x11, 0, 0, 5))).toEqual(['foreign']);
    // A reply class with NUM 0 is not a broadcast.
    expect(sendRisks(id(2, Cls.STATUS, 0, 0))).toEqual([]);
  });

  it('agrees with the protocol codec for the real ESTOP and INFO_REQ frames', () => {
    expect(sendRisks(encodeEstop(BROADCAST_ALL).id)).toEqual([]);
    expect(sendRisks(encodeInfoReq({ devType: DevType.MOTOR_CONTROLLER, num: 2 }, { page: 0 }).id)).toEqual([]);
  });
});

describe('filter matcher', () => {
  const status = id(2, Cls.STATUS, 0, 3);
  const t = (i: number, dir: 'rx' | 'tx' = 'rx', flags = 0) => ({ id: i, dir, flags });

  it('is inactive when empty and matches everything', () => {
    expect(isFilterActive(EMPTY_FILTER)).toBe(false);
    expect(compileFilter(EMPTY_FILTER).match(t(status), null)).toBe(true);
  });

  it('filters by card, class, direction and exact id', () => {
    expect(compileFilter({ ...EMPTY_FILTER, card: { devType: 2, num: 3 } }).match(t(status), null)).toBe(true);
    expect(compileFilter({ ...EMPTY_FILTER, card: { devType: 2, num: 4 } }).match(t(status), null)).toBe(false);
    expect(compileFilter({ ...EMPTY_FILTER, card: { devType: 2, num: 3 } }).match(t(id(2, 0x11, 0, 3, 5)), null)).toBe(false);
    expect(compileFilter({ ...EMPTY_FILTER, classes: [Cls.STATUS] }).match(t(status), null)).toBe(true);
    expect(compileFilter({ ...EMPTY_FILTER, classes: [Cls.CTRL] }).match(t(status), null)).toBe(false);
    expect(compileFilter({ ...EMPTY_FILTER, classes: [-1] }).match(t(id(10, 1, 0, 1)), null)).toBe(true);
    expect(compileFilter({ ...EMPTY_FILTER, dir: 'tx' }).match(t(status, 'rx'), null)).toBe(false);
    expect(compileFilter({ ...EMPTY_FILTER, idEq: status }).match(t(status), null)).toBe(true);
    expect(compileFilter({ ...EMPTY_FILTER, idEq: status + 1 }).match(t(status), null)).toBe(false);
  });

  it('searches id hex, payload hex and class names with AND semantics', () => {
    const data = Uint8Array.from([0xde, 0xad, 0xbe, 0xef]);
    const m = (text: string): boolean => compileFilter({ ...EMPTY_FILTER, text }).match(t(status), data);
    expect(m('0844')).toBe(true); // in the id
    expect(m('0x1a')).toBe(false);
    expect(m('dead')).toBe(true);
    expect(m('adbe')).toBe(true);
    expect(m('status')).toBe(true);
    expect(m('STATUS dead')).toBe(true);
    expect(m('status beef00')).toBe(false);
    expect(m('d:efef')).toBe(false);
    expect(m('d:beef')).toBe(true);
    expect(m('id:dead')).toBe(false);
    expect(compileFilter({ ...EMPTY_FILTER, text: 'id:0203' }).needsData).toBe(false);
    expect(compileFilter({ ...EMPTY_FILTER, text: 'dead' }).needsData).toBe(true);
  });

  it('keeps only problem frames when asked', () => {
    const f = compileFilter({ ...EMPTY_FILTER, problemsOnly: true });
    expect(f.match(t(status, 'rx', 0), null)).toBe(false);
    expect(f.match(t(status, 'rx', FLAG_ERROR), null)).toBe(true);
    expect(f.match(t(status, 'tx', FLAG_UNANSWERED), null)).toBe(true);
  });

  it('derives the card from an id', () => {
    expect(cardOf(status)).toEqual({ devType: 2, num: 3 });
    expect(cardOf(id(2, 0x11, 0, 3, 5))).toBeNull();
  });
});

describe('IdAggregator', () => {
  it('measures the period of a regular frame and its frequency', () => {
    const agg = new IdAggregator();
    const trace = new FrameTrace(256);
    const sid = id(2, Cls.STATUS, 0, 1);
    for (let i = 0; i < 50; i++) trace.push('rx', frame(1000 + i * 20, sid, [i]));
    agg.update(trace);
    const e = agg.entry(sid);
    expect(e?.count).toBe(50);
    expect(e?.periodMs).toBeCloseTo(20, 6);
    expect(freqOf(e?.periodMs ?? null)).toBeCloseTo(50, 6);
  });

  it('smooths jitter and follows a rate change', () => {
    const agg = new IdAggregator();
    const sid = id(2, Cls.STATUS, 0, 1);
    let t = 0;
    for (let i = 0; i < 40; i++) {
      t += i % 2 ? 9 : 11;
      agg.add({ seq: i, t, dir: 'rx', id: sid, fd: false, brs: false, data: new Uint8Array(1) });
    }
    expect(agg.entry(sid)?.periodMs).toBeGreaterThan(9.5);
    expect(agg.entry(sid)?.periodMs).toBeLessThan(10.5);
    for (let i = 40; i < 90; i++) {
      t += 50;
      agg.add({ seq: i, t, dir: 'rx', id: sid, fd: false, brs: false, data: new Uint8Array(1) });
    }
    expect(agg.entry(sid)?.periodMs).toBeCloseTo(50, 0);
  });

  it('has no period after a single frame, counts directions and tracks changed bytes', () => {
    const agg = new IdAggregator();
    const a = id(2, Cls.CTRL, 0, 1);
    agg.add({ seq: 0, t: 100, dir: 'tx', id: a, fd: false, brs: false, data: Uint8Array.from([1, 2, 3]) });
    expect(agg.entry(a)?.periodMs).toBeNull();
    agg.add({ seq: 1, t: 110, dir: 'tx', id: a, fd: false, brs: false, data: Uint8Array.from([1, 9, 3]) });
    const e = agg.entry(a);
    expect(e?.txCount).toBe(2);
    expect(e?.rxCount).toBe(0);
    expect(e?.changedAt[0]).toBeNaN();
    expect(e?.changedAt[1]).toBe(110);
    expect(e?.changedAt[2]).toBeNaN();
  });

  it('is incremental, survives ring wrap and resets with the trace', () => {
    const agg = new IdAggregator();
    const trace = new FrameTrace(8);
    const sid = id(2, Cls.STATUS, 0, 1);
    for (let i = 0; i < 5; i++) trace.push('rx', frame(i * 10, sid));
    agg.update(trace);
    for (let i = 5; i < 30; i++) trace.push('rx', frame(i * 10, sid));
    agg.update(trace);
    // 5 seen before, then only the 8 still in the ring (22..29) from the second batch.
    expect(agg.entry(sid)?.count).toBe(5 + 8);
    trace.clear();
    trace.push('rx', frame(0, sid));
    agg.update(trace);
    expect(agg.entry(sid)?.count).toBe(1);
  });

  it('computes per-second rates by id and class', () => {
    const agg = new IdAggregator();
    const s1 = id(2, Cls.STATUS, 0, 1);
    const s2 = id(2, Cls.STATUS, 0, 2);
    const p = id(2, Cls.PARAM_RSP, 0, 1);
    agg.sampleRates(0);
    for (let i = 0; i < 100; i++) agg.add({ seq: i, t: i * 10, dir: 'rx', id: s1, fd: false, brs: false, data: new Uint8Array(1) });
    for (let i = 0; i < 50; i++) agg.add({ seq: 100 + i, t: i * 20, dir: 'rx', id: s2, fd: false, brs: false, data: new Uint8Array(1) });
    for (let i = 0; i < 10; i++) agg.add({ seq: 150 + i, t: i * 100, dir: 'rx', id: p, fd: false, brs: false, data: new Uint8Array(1) });
    agg.sampleRates(1000);
    expect(agg.entry(s1)?.fps).toBeCloseTo(100, 6);
    expect(agg.classFps.get(Cls.STATUS)).toBeCloseTo(150, 6);
    expect(agg.classFps.get(Cls.PARAM_RSP)).toBeCloseTo(10, 6);
    expect(agg.totalFps).toBeCloseTo(160, 6);
    expect(agg.topTalkers(2).map((e) => e.id)).toEqual([s1, s2]);
  });
});

describe('FrameAnnotator', () => {
  const info = id(2, Cls.SYS_REQ, 3, 4);
  const infoRsp = id(2, Cls.SYS_RSP, 3, 4);

  it('maps requests to their responses', () => {
    expect(expectedResponse(info)).toEqual({ cls: Cls.SYS_RSP, index: 3 });
    expect(expectedResponse(id(2, Cls.PARAM_REQ, 1, 4))).toEqual({ cls: Cls.PARAM_RSP, index: 0 });
    expect(expectedResponse(id(0, Cls.SYS_REQ, 0, 0))).toEqual({ cls: Cls.ENUM_RSP, index: -1 });
    expect(expectedResponse(id(2, Cls.SYS_REQ, 7, 4))).toBeNull();
    expect(expectedResponse(id(2, Cls.CTRL, 0, 4))).toBeNull();
  });

  it('flags a request nobody answered, but not an answered one', () => {
    const trace = new FrameTrace(64);
    const ann = new FrameAnnotator(64);
    trace.push('tx', frame(0, info)); // seq 0: answered
    trace.push('rx', frame(5, infoRsp));
    trace.push('tx', frame(10, id(2, Cls.SYS_REQ, 3, 5))); // seq 2: board 5 never answers
    trace.push('rx', frame(20, infoRsp)); // board 4 answers, not 5
    ann.update(trace);
    expect(ann.flagsOf(2)).toBe(0); // still within the timeout
    trace.push('rx', frame(10 + RESPONSE_TIMEOUT_MS + 1, id(2, Cls.STATUS, 0, 4)));
    ann.update(trace);
    expect(ann.flagsOf(0)).toBe(0);
    expect(ann.flagsOf(2)).toBe(FLAG_UNANSWERED);
  });

  it('treats the first ENUM_RSP as the answer to a broadcast ENUM_REQ', () => {
    const trace = new FrameTrace(64);
    const ann = new FrameAnnotator(64);
    trace.push('tx', frame(0, id(0, Cls.SYS_REQ, 0, 0)));
    trace.push('rx', frame(30, id(2, Cls.ENUM_RSP, 1, 9)));
    trace.push('rx', frame(900, id(2, Cls.STATUS, 0, 1)));
    ann.update(trace);
    expect(ann.flagsOf(0)).toBe(0);
  });

  it('flags error responses', () => {
    const fault = Uint8Array.from([0x01, 0x40, 0x00, 0xcd, 0xab, 1, 0, 0]); // heartbeat with fault bits
    const ok = Uint8Array.from([0x01, 0x00, 0x00, 0xcd, 0xab, 1, 0, 0]);
    const hb = id(2, Cls.SYS_RSP, 0, 3);
    expect(isErrorFrame(hb, fault)).toBe(true);
    expect(isErrorFrame(hb, ok)).toBe(false);
    expect(isErrorFrame(id(2, Cls.SYS_RSP, 5, 3), Uint8Array.from([0x40, 5, 0, 0, 0, 0]))).toBe(true); // command failed
    expect(isErrorFrame(id(2, Cls.SYS_RSP, 5, 3), Uint8Array.from([0x40, 0, 0, 0, 0, 0]))).toBe(false);
    expect(isErrorFrame(id(2, Cls.STATUS, 0, 3), fault)).toBe(false);
    const trace = new FrameTrace(16);
    const ann = new FrameAnnotator(16);
    trace.push('rx', frame(0, hb, Array.from(fault)));
    ann.update(trace);
    expect(ann.flagsOf(0)).toBe(FLAG_ERROR);
  });
});

describe('StreamIndex', () => {
  const sid = id(2, Cls.STATUS, 0, 1);
  const cid = id(2, Cls.CTRL, 0, 1);
  const none = (): number => 0;

  it('lists every frame without a filter and trims what the ring dropped', () => {
    const trace = new FrameTrace(5);
    const idx = new StreamIndex();
    for (let i = 0; i < 3; i++) trace.push('rx', frame(i, sid));
    expect(idx.update(trace, EMPTY_FILTER, none)).toEqual([0, 1, 2]);
    for (let i = 3; i < 9; i++) trace.push('rx', frame(i, sid));
    expect(idx.update(trace, EMPTY_FILTER, none)).toEqual([4, 5, 6, 7, 8]);
  });

  it('applies filters incrementally and rebuilds on a filter change', () => {
    const trace = new FrameTrace(50);
    const idx = new StreamIndex();
    const filter = { ...EMPTY_FILTER, classes: [Cls.CTRL] };
    trace.push('rx', frame(0, sid));
    trace.push('tx', frame(1, cid, [1]));
    expect(idx.update(trace, filter, none)).toEqual([1]);
    trace.push('rx', frame(2, sid));
    trace.push('tx', frame(3, cid, [2]));
    expect(idx.update(trace, filter, none)).toEqual([1, 3]);
    expect(idx.update(trace, { ...EMPTY_FILTER, classes: [Cls.STATUS] }, none)).toEqual([0, 2]);
    expect(idx.update(trace, { ...EMPTY_FILTER, text: 'd:02' }, none)).toEqual([3]);
  });

  it('follows late annotations in problems-only mode', () => {
    const trace = new FrameTrace(50);
    const idx = new StreamIndex();
    trace.push('tx', frame(0, id(2, Cls.SYS_REQ, 3, 4)));
    const flags = new Map<number, number>();
    const f = { ...EMPTY_FILTER, problemsOnly: true };
    expect(idx.update(trace, f, (s) => flags.get(s) ?? 0)).toEqual([]);
    flags.set(0, FLAG_UNANSWERED);
    expect(idx.update(trace, f, (s) => flags.get(s) ?? 0)).toEqual([0]);
  });
});

describe('formatters', () => {
  const f = { seq: 7, t: 1234.5678, dir: 'rx' as const, id: 0x18080c41, fd: false, brs: false, data: Uint8Array.from([1, 2, 0xab]) };

  it('writes candump log lines', () => {
    expect(candumpLine(f)).toBe('(1.234568) can0 18080C41#0102AB');
    expect(candumpLine({ ...f, fd: true, brs: true })).toBe('(1.234568) can0 18080C41##10102AB');
    expect(candumpLine({ ...f, fd: true, brs: false, data: new Uint8Array(0) }, 'vcan1')).toBe('(1.234568) vcan1 18080C41##0');
    expect(toCandump([f, { ...f, t: 2000 }])).toBe('(1.234568) can0 18080C41#0102AB\n(2.000000) can0 18080C41#0102AB\n');
    expect(toCandump([])).toBe('');
  });

  it('writes CSV with quoting', () => {
    expect(csvRow({ ...f, fd: true, brs: true }, 'STATUS · ESC, #3')).toBe('7,1.234568,RX,0x18080C41,FD·BRS,3,01 02 AB,LEGACY/3,"STATUS · ESC, #3"');
    const csv = toCsv([{ frame: f, summary: 'x' }]);
    expect(csv.split('\n')[0]).toBe('seq,time_s,dir,id,type,dlc,data,class,summary');
    expect(csv.endsWith('\n')).toBe(true);
  });

  it('formats time columns', () => {
    expect(fmtFrameTime('abs', 1500, null, dec)).toBe('1.500000');
    expect(fmtFrameTime('rel', 1500, 1000, dec)).toBe('0.500000');
    expect(fmtFrameTime('delta', 1500, 1499.75, dec)).toBe('+0.250 ms');
    expect(fmtFrameTime('delta', 1500, null, dec)).toBe('—');
    expect(fmtDelta(12.5, dec)).toBe('+12.5 ms');
    expect(fmtDelta(2400, dec)).toBe('+2.40 s');
    expect(fmtDelta(-3, dec)).toBe('−3.00 ms');
  });
});
