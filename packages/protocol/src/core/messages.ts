import {
  Cls,
  ESTOP_MAGIC_0,
  ESTOP_MAGIC_1,
  EnumFlag,
  FwReq,
  FwRsp,
  InfoPage,
  ParamReq,
  ParamRsp,
  PType,
  STREAM_SLOTS,
  StateFlag,
  StreamReq,
  StreamRsp,
  SysReq,
  SysRsp,
} from './constants';
import {
  readF32,
  readI32,
  readU16,
  readU24,
  readU32,
  readU48,
  writeF32,
  writeU16,
  writeU24,
  writeU32,
  writeU48,
} from './bytes';
import { hash10 } from './fnv';
import { type Address, type TxFrame, makeTxFrame } from './frame';
import { encodeEnumRspId, idClass, idIndex, messageId } from './id';
import { decodeAscii, encodeAscii } from './text';

/*
 * Typed codecs for every CyCAN message (PROTOCOL §3–§9).
 *
 * Conventions:
 * - `encodeX(addr, fields)` returns a ready-to-send TxFrame. `addr` is the destination for
 *   host-to-board messages and the sender for board-to-host messages.
 * - `decodeX(data)` never throws: it returns null when the payload is shorter than the
 *   message needs. Longer payloads are accepted (extra bytes ignored) because some CAN
 *   stacks always send DLC 8.
 * - Reserved bytes are written as 0 and ignored on decode.
 */

type Fields<T> = Omit<T, 'kind'>;

function frame(addr: Address, cls: number, index: number, data: Uint8Array): TxFrame {
  return makeTxFrame(messageId(addr, cls, index), data);
}

function requireLength(name: string, b: Uint8Array, len: number): void {
  if (b.length !== len) throw new RangeError(`${name}: expected ${len} bytes, got ${b.length}`);
}

// ---------------------------------------------------------------------------------------
// SYS_REQ (host -> board)

export interface EnumReq {
  kind: 'enumReq';
  /** 0 = all boards, 1 = only unassigned / conflicting boards. */
  filter: number;
}

export function encodeEnumReq(addr: Address, m: Fields<EnumReq>): TxFrame {
  return frame(addr, Cls.SYS_REQ, SysReq.ENUM_REQ, Uint8Array.of(m.filter & 0xff));
}

export function decodeEnumReq(d: Uint8Array): EnumReq | null {
  if (d.length < 1) return null;
  return { kind: 'enumReq', filter: d[0] ?? 0 };
}

export interface AssignId {
  kind: 'assignId';
  uid48: number;
  newNum: number;
  /** flags bit0: write the new number to non-volatile memory. */
  persist: boolean;
}

export function encodeAssignId(addr: Address, m: Fields<AssignId>): TxFrame {
  const d = new Uint8Array(8);
  writeU48(d, 0, m.uid48);
  d[6] = m.newNum & 0x3f;
  d[7] = m.persist ? 1 : 0;
  return frame(addr, Cls.SYS_REQ, SysReq.ASSIGN_ID, d);
}

export function decodeAssignId(d: Uint8Array): AssignId | null {
  if (d.length < 8) return null;
  return { kind: 'assignId', uid48: readU48(d, 0), newNum: d[6] ?? 0, persist: ((d[7] ?? 0) & 1) !== 0 };
}

/** Addressed IDENTIFY: `[seconds]`, 0 turns it off. */
export interface Identify {
  kind: 'identify';
  seconds: number;
}

/** UID-addressed broadcast IDENTIFY: `[uid48][seconds]`; works for unassigned/conflicting boards. */
export interface IdentifyUid {
  kind: 'identifyUid';
  uid48: number;
  seconds: number;
}

export function encodeIdentify(addr: Address, m: Fields<Identify>): TxFrame {
  return frame(addr, Cls.SYS_REQ, SysReq.IDENTIFY, Uint8Array.of(m.seconds & 0xff));
}

export function encodeIdentifyUid(addr: Address, m: Fields<IdentifyUid>): TxFrame {
  const d = new Uint8Array(7);
  writeU48(d, 0, m.uid48);
  d[6] = m.seconds & 0xff;
  return frame(addr, Cls.SYS_REQ, SysReq.IDENTIFY, d);
}

/** The two IDENTIFY forms are told apart by length: 1..6 bytes addressed, 7+ bytes UID form. */
export function decodeIdentify(d: Uint8Array): Identify | IdentifyUid | null {
  if (d.length >= 7) return { kind: 'identifyUid', uid48: readU48(d, 0), seconds: d[6] ?? 0 };
  if (d.length >= 1) return { kind: 'identify', seconds: d[0] ?? 0 };
  return null;
}

export interface InfoReq {
  kind: 'infoReq';
  page: number;
}

export function encodeInfoReq(addr: Address, m: Fields<InfoReq>): TxFrame {
  return frame(addr, Cls.SYS_REQ, SysReq.INFO_REQ, Uint8Array.of(m.page & 0xff));
}

export function decodeInfoReq(d: Uint8Array): InfoReq | null {
  if (d.length < 1) return null;
  return { kind: 'infoReq', page: d[0] ?? 0 };
}

export interface NameSet {
  kind: 'nameSet';
  /** 0..2; answered with INFO_RSP page 4 + page. */
  page: number;
  /** Exactly 7 bytes of the 21-byte UTF-8 name. */
  bytes: Uint8Array;
}

export function encodeNameSet(addr: Address, m: Fields<NameSet>): TxFrame {
  requireLength('NAME_SET bytes', m.bytes, 7);
  const d = new Uint8Array(8);
  d[0] = m.page & 0xff;
  d.set(m.bytes, 1);
  return frame(addr, Cls.SYS_REQ, SysReq.NAME_SET, d);
}

export function decodeNameSet(d: Uint8Array): NameSet | null {
  if (d.length < 8) return null;
  return { kind: 'nameSet', page: d[0] ?? 0, bytes: d.slice(1, 8) };
}

export interface CommandReq {
  kind: 'command';
  cmd: number;
  /** u32 argument; f32 arguments travel as their bit pattern (see f32ToBits). */
  arg: number;
}

export function encodeCommand(addr: Address, m: Fields<CommandReq>): TxFrame {
  const d = new Uint8Array(8);
  d[0] = m.cmd & 0xff;
  writeU32(d, 1, m.arg);
  return frame(addr, Cls.SYS_REQ, SysReq.COMMAND, d);
}

export function decodeCommand(d: Uint8Array): CommandReq | null {
  if (d.length < 5) return null;
  return { kind: 'command', cmd: d[0] ?? 0, arg: readU32(d, 1) };
}

export interface FaultReq {
  kind: 'faultReq';
}

export function encodeFaultReq(addr: Address): TxFrame {
  return frame(addr, Cls.SYS_REQ, SysReq.FAULT_REQ, new Uint8Array(0));
}

export function decodeFaultReq(_d: Uint8Array): FaultReq {
  return { kind: 'faultReq' };
}

export interface Estop {
  kind: 'estop';
}

export function encodeEstop(addr: Address): TxFrame {
  return frame(addr, Cls.SYS_REQ, SysReq.ESTOP, Uint8Array.of(ESTOP_MAGIC_0, ESTOP_MAGIC_1));
}

/** Requires the 0xE5 0x70 magic so a corrupted or foreign frame never latches ESTOP. */
export function decodeEstop(d: Uint8Array): Estop | null {
  if (d.length < 2 || d[0] !== ESTOP_MAGIC_0 || d[1] !== ESTOP_MAGIC_1) return null;
  return { kind: 'estop' };
}

// ---------------------------------------------------------------------------------------
// SYS_RSP (board -> host)

export interface Heartbeat {
  kind: 'heartbeat';
  /** DeviceState (0..15). */
  state: number;
  unsaved: boolean;
  enabled: boolean;
  warning: boolean;
  identify: boolean;
  /** Active fault bit mask. */
  fault: number;
  uid16: number;
  fwMajor: number;
  fwMinor: number;
  fwPatch: number;
}

export function encodeHeartbeat(addr: Address, m: Fields<Heartbeat>): TxFrame {
  const d = new Uint8Array(8);
  d[0] =
    (m.state & 0x0f) |
    (m.unsaved ? StateFlag.UNSAVED : 0) |
    (m.enabled ? StateFlag.ENABLED : 0) |
    (m.warning ? StateFlag.WARNING : 0) |
    (m.identify ? StateFlag.IDENTIFY : 0);
  writeU16(d, 1, m.fault);
  writeU16(d, 3, m.uid16);
  d[5] = m.fwMajor & 0xff;
  d[6] = m.fwMinor & 0xff;
  d[7] = m.fwPatch & 0xff;
  return frame(addr, Cls.SYS_RSP, SysRsp.HEARTBEAT, d);
}

export function decodeHeartbeat(d: Uint8Array): Heartbeat | null {
  if (d.length < 8) return null;
  const f = d[0] ?? 0;
  return {
    kind: 'heartbeat',
    state: f & 0x0f,
    unsaved: (f & StateFlag.UNSAVED) !== 0,
    enabled: (f & StateFlag.ENABLED) !== 0,
    warning: (f & StateFlag.WARNING) !== 0,
    identify: (f & StateFlag.IDENTIFY) !== 0,
    fault: readU16(d, 1),
    uid16: readU16(d, 3),
    fwMajor: d[5] ?? 0,
    fwMinor: d[6] ?? 0,
    fwPatch: d[7] ?? 0,
  };
}

/** INFO_RSP page 0. */
export interface InfoRspDevice {
  kind: 'infoRsp';
  section: 'device';
  page: 0;
  model: number;
  hwRev: number;
  protoMajor: number;
  protoMinor: number;
  catalogRev: number;
  bootloaderVer: number;
}

/** INFO_RSP page 3. `buildDay` counts days since 2026-01-01. */
export interface InfoRspBuild {
  kind: 'infoRsp';
  section: 'build';
  page: 3;
  gitHash: number;
  buildDay: number;
  dirty: boolean;
}

/** INFO_RSP pages 1, 2 (UID chunks), 4..6 (name chunks) and unknown pages: raw 7 bytes. */
export interface InfoRspBytes {
  kind: 'infoRsp';
  section: 'bytes';
  page: number;
  bytes: Uint8Array;
}

export type InfoRsp = InfoRspDevice | InfoRspBuild | InfoRspBytes;

export function encodeInfoRsp(addr: Address, m: Fields<InfoRspDevice> | Fields<InfoRspBuild> | Fields<InfoRspBytes>): TxFrame {
  const d = new Uint8Array(8);
  d[0] = m.page & 0xff;
  switch (m.section) {
    case 'device':
      d[1] = m.model & 0xff;
      d[2] = m.hwRev & 0xff;
      d[3] = m.protoMajor & 0xff;
      d[4] = m.protoMinor & 0xff;
      writeU16(d, 5, m.catalogRev);
      d[7] = m.bootloaderVer & 0xff;
      break;
    case 'build':
      writeU32(d, 1, m.gitHash);
      writeU16(d, 5, m.buildDay);
      d[7] = m.dirty ? 1 : 0;
      break;
    case 'bytes':
      if (m.bytes.length > 7) throw new RangeError('INFO_RSP bytes: at most 7 bytes');
      d.set(m.bytes, 1);
      break;
  }
  return frame(addr, Cls.SYS_RSP, SysRsp.INFO_RSP, d);
}

export function decodeInfoRsp(d: Uint8Array): InfoRsp | null {
  if (d.length < 8) return null;
  const page = d[0] ?? 0;
  if (page === InfoPage.DEVICE) {
    return {
      kind: 'infoRsp',
      section: 'device',
      page: 0,
      model: d[1] ?? 0,
      hwRev: d[2] ?? 0,
      protoMajor: d[3] ?? 0,
      protoMinor: d[4] ?? 0,
      catalogRev: readU16(d, 5),
      bootloaderVer: d[7] ?? 0,
    };
  }
  if (page === InfoPage.BUILD) {
    return { kind: 'infoRsp', section: 'build', page: 3, gitHash: readU32(d, 1), buildDay: readU16(d, 5), dirty: d[7] !== 0 };
  }
  return { kind: 'infoRsp', section: 'bytes', page, bytes: d.slice(1, 8) };
}

/** Splits a 96-bit UID into the INFO page 1 (7 bytes) and page 2 (5 bytes + 0 0) chunks. */
export function uid96ToInfoPages(uid96: Uint8Array): [Uint8Array, Uint8Array] {
  requireLength('uid96', uid96, 12);
  const p2 = new Uint8Array(7);
  p2.set(uid96.subarray(7, 12));
  return [uid96.slice(0, 7), p2];
}

export function uid96FromInfoPages(page1: Uint8Array, page2: Uint8Array): Uint8Array {
  const u = new Uint8Array(12);
  u.set(page1.subarray(0, 7), 0);
  u.set(page2.subarray(0, 5), 7);
  return u;
}

export interface CommandRsp {
  kind: 'commandRsp';
  cmd: number;
  /** CommandStatus. */
  status: number;
  result: number;
}

export function encodeCommandRsp(addr: Address, m: Fields<CommandRsp>): TxFrame {
  const d = new Uint8Array(8);
  d[0] = m.cmd & 0xff;
  d[1] = m.status & 0xff;
  writeU32(d, 2, m.result);
  return frame(addr, Cls.SYS_RSP, SysRsp.COMMAND_RSP, d);
}

export function decodeCommandRsp(d: Uint8Array): CommandRsp | null {
  if (d.length < 6) return null;
  return { kind: 'commandRsp', cmd: d[0] ?? 0, status: d[1] ?? 0, result: readU32(d, 2) };
}

export interface FaultRsp {
  kind: 'faultRsp';
  active: number;
  sticky: number;
  warn: number;
}

export function encodeFaultRsp(addr: Address, m: Fields<FaultRsp>): TxFrame {
  const d = new Uint8Array(8);
  writeU16(d, 0, m.active);
  writeU16(d, 2, m.sticky);
  writeU16(d, 4, m.warn);
  return frame(addr, Cls.SYS_RSP, SysRsp.FAULT_RSP, d);
}

export function decodeFaultRsp(d: Uint8Array): FaultRsp | null {
  if (d.length < 6) return null;
  return { kind: 'faultRsp', active: readU16(d, 0), sticky: readU16(d, 2), warn: readU16(d, 4) };
}

// ---------------------------------------------------------------------------------------
// ENUM_RSP (board -> host, special id)

export interface EnumRsp {
  kind: 'enumRsp';
  uid48: number;
  num: number;
  conflict: boolean;
  bootloader: boolean;
  model: number;
}

/** Only `addr.devType` is used: the low 10 id bits carry hash10(uid48), not the NUM. */
export function encodeEnumRsp(addr: Address, m: Fields<EnumRsp>): TxFrame {
  const d = new Uint8Array(8);
  writeU48(d, 0, m.uid48);
  d[6] = (m.num & 0x3f) | (m.conflict ? EnumFlag.CONFLICT : 0) | (m.bootloader ? EnumFlag.BOOTLOADER : 0);
  d[7] = m.model & 0xff;
  return makeTxFrame(encodeEnumRspId(addr.devType, hash10(m.uid48)), d);
}

export function decodeEnumRsp(d: Uint8Array): EnumRsp | null {
  if (d.length < 8) return null;
  const f = d[6] ?? 0;
  return {
    kind: 'enumRsp',
    uid48: readU48(d, 0),
    num: f & 0x3f,
    conflict: (f & EnumFlag.CONFLICT) !== 0,
    bootloader: (f & EnumFlag.BOOTLOADER) !== 0,
    model: d[7] ?? 0,
  };
}

// ---------------------------------------------------------------------------------------
// PARAM

/** Writes a 32-bit parameter value according to its ptype (bool -> 0/1, enum/u32 unsigned). */
export function writeParamValue(ptype: number, value: number, b: Uint8Array, o: number): void {
  switch (ptype) {
    case PType.F32:
      writeF32(b, o, value);
      break;
    case PType.I32:
      writeU32(b, o, Math.round(value) | 0);
      break;
    case PType.BOOL:
      writeU32(b, o, value ? 1 : 0);
      break;
    default:
      writeU32(b, o, Math.round(value) >>> 0);
  }
}

/** Reads a parameter value; unknown ptypes read as u32 so nothing is lost. */
export function readParamValue(ptype: number, b: Uint8Array, o: number): number {
  switch (ptype) {
    case PType.F32:
      return readF32(b, o);
    case PType.I32:
      return readI32(b, o);
    case PType.BOOL:
      return readU32(b, o) !== 0 ? 1 : 0;
    default:
      return readU32(b, o);
  }
}

export interface ParamGet {
  kind: 'paramGet';
  pid: number;
}

export function encodeParamGet(addr: Address, m: Fields<ParamGet>): TxFrame {
  const d = new Uint8Array(2);
  writeU16(d, 0, m.pid);
  return frame(addr, Cls.PARAM_REQ, ParamReq.GET, d);
}

export function decodeParamGet(d: Uint8Array): ParamGet | null {
  if (d.length < 2) return null;
  return { kind: 'paramGet', pid: readU16(d, 0) };
}

export interface ParamSet {
  kind: 'paramSet';
  pid: number;
  ptype: number;
  value: number;
}

export function encodeParamSet(addr: Address, m: Fields<ParamSet>): TxFrame {
  const d = new Uint8Array(8);
  writeU16(d, 0, m.pid);
  d[2] = m.ptype & 0xff;
  writeParamValue(m.ptype, m.value, d, 4);
  return frame(addr, Cls.PARAM_REQ, ParamReq.SET, d);
}

export function decodeParamSet(d: Uint8Array): ParamSet | null {
  if (d.length < 8) return null;
  const ptype = d[2] ?? 0;
  return { kind: 'paramSet', pid: readU16(d, 0), ptype, value: readParamValue(ptype, d, 4) };
}

export interface ParamValue {
  kind: 'paramValue';
  pid: number;
  ptype: number;
  /** ParamStatus. */
  status: number;
  value: number;
}

export function encodeParamValue(addr: Address, m: Fields<ParamValue>): TxFrame {
  const d = new Uint8Array(8);
  writeU16(d, 0, m.pid);
  d[2] = m.ptype & 0xff;
  d[3] = m.status & 0xff;
  writeParamValue(m.ptype, m.value, d, 4);
  return frame(addr, Cls.PARAM_RSP, ParamRsp.VALUE, d);
}

export function decodeParamValue(d: Uint8Array): ParamValue | null {
  if (d.length < 8) return null;
  const ptype = d[2] ?? 0;
  return { kind: 'paramValue', pid: readU16(d, 0), ptype, status: d[3] ?? 0, value: readParamValue(ptype, d, 4) };
}

// ---------------------------------------------------------------------------------------
// STREAM

export interface StreamConfig {
  kind: 'streamConfig';
  slot: number;
  /** Signal id; 0xFFFF clears the slot. */
  sid: number;
}

export function encodeStreamConfig(addr: Address, m: Fields<StreamConfig>): TxFrame {
  const d = new Uint8Array(3);
  d[0] = m.slot & 0xff;
  writeU16(d, 1, m.sid);
  return frame(addr, Cls.STREAM_REQ, StreamReq.CONFIG, d);
}

export function decodeStreamConfig(d: Uint8Array): StreamConfig | null {
  if (d.length < 3) return null;
  return { kind: 'streamConfig', slot: d[0] ?? 0, sid: readU16(d, 1) };
}

export interface StreamStart {
  kind: 'streamStart';
  /** Sample period in units of 100 µs. Also acts as keepalive. */
  period100us: number;
}

export function encodeStreamStart(addr: Address, m: Fields<StreamStart>): TxFrame {
  const d = new Uint8Array(4);
  writeU16(d, 0, m.period100us);
  return frame(addr, Cls.STREAM_REQ, StreamReq.START, d);
}

export function decodeStreamStart(d: Uint8Array): StreamStart | null {
  if (d.length < 2) return null;
  return { kind: 'streamStart', period100us: readU16(d, 0) };
}

export interface StreamStop {
  kind: 'streamStop';
}

export function encodeStreamStop(addr: Address): TxFrame {
  return frame(addr, Cls.STREAM_REQ, StreamReq.STOP, new Uint8Array(0));
}

export function decodeStreamStop(_d: Uint8Array): StreamStop {
  return { kind: 'streamStop' };
}

export interface StreamData {
  kind: 'streamData';
  seq: number;
  firstSlot: number;
  /** Board timestamp, 100 µs units, wraps at 65536. */
  t100us: number;
  /** Values for slots firstSlot, firstSlot+1, … */
  values: number[];
}

export function encodeStreamData(addr: Address, m: Fields<StreamData>): TxFrame {
  const k = m.values.length;
  if (k < 1 || m.firstSlot + k > STREAM_SLOTS) throw new RangeError('STREAM DATA: slot range outside 0..14');
  const d = new Uint8Array(4 + 4 * k);
  d[0] = m.seq & 0xff;
  d[1] = m.firstSlot & 0xff;
  writeU16(d, 2, m.t100us);
  for (let i = 0; i < k; i++) writeF32(d, 4 + 4 * i, m.values[i] ?? 0);
  return frame(addr, Cls.STREAM_RSP, StreamRsp.DATA, d);
}

/**
 * Number of slot values a DATA payload carries. FD padding can add trailing values; the
 * host should only use slots it configured (see report: protocol question on padding).
 */
export function streamDataCount(d: Uint8Array): number {
  if (d.length < 8) return 0;
  const first = d[1] ?? 0;
  if (first >= STREAM_SLOTS) return 0;
  return Math.min((d.length - 4) >> 2, STREAM_SLOTS - first);
}

/** Allocation-free access to value `i` of a DATA payload. */
export function streamDataValue(d: Uint8Array, i: number): number {
  return readF32(d, 4 + 4 * i);
}

export function decodeStreamData(d: Uint8Array): StreamData | null {
  const k = streamDataCount(d);
  if (k === 0) return null;
  const values = new Array<number>(k);
  for (let i = 0; i < k; i++) values[i] = readF32(d, 4 + 4 * i);
  return { kind: 'streamData', seq: d[0] ?? 0, firstSlot: d[1] ?? 0, t100us: readU16(d, 2), values };
}

// ---------------------------------------------------------------------------------------
// FW (bootloader only)

export interface FwBegin {
  kind: 'fwBegin';
  /** Whole .cyfw file size (header + payload). */
  size: number;
  /** CRC32 of the whole file. */
  crc32: number;
}

export function encodeFwBegin(addr: Address, m: Fields<FwBegin>): TxFrame {
  const d = new Uint8Array(8);
  writeU32(d, 0, m.size);
  writeU32(d, 4, m.crc32);
  return frame(addr, Cls.FW_REQ, FwReq.BEGIN, d);
}

export function decodeFwBegin(d: Uint8Array): FwBegin | null {
  if (d.length < 8) return null;
  return { kind: 'fwBegin', size: readU32(d, 0), crc32: readU32(d, 4) };
}

export interface FwData {
  kind: 'fwData';
  /** Byte offset into the file, 24 bits. */
  offset: number;
  bytes: Uint8Array;
}

/**
 * Chunks must be 5 bytes (classic) or 61 bytes (FD); any other FD length is zero padded to
 * the next FD size and the padding counts as image data, so only the final chunk may be short.
 */
export function encodeFwData(addr: Address, m: Fields<FwData>): TxFrame {
  if (m.bytes.length < 1 || m.bytes.length > 61) throw new RangeError('FW DATA: 1..61 bytes');
  if (m.offset < 0 || m.offset > 0xffffff) throw new RangeError('FW DATA: offset exceeds 24 bits');
  const d = new Uint8Array(3 + m.bytes.length);
  writeU24(d, 0, m.offset);
  d.set(m.bytes, 3);
  return frame(addr, Cls.FW_REQ, FwReq.DATA, d);
}

/** `bytes` is a view into `d` (no copy). */
export function decodeFwData(d: Uint8Array): FwData | null {
  if (d.length < 4) return null;
  return { kind: 'fwData', offset: readU24(d, 0), bytes: d.subarray(3) };
}

export interface FwEnd {
  kind: 'fwEnd';
}

export function encodeFwEnd(addr: Address): TxFrame {
  return frame(addr, Cls.FW_REQ, FwReq.END, new Uint8Array(0));
}

export function decodeFwEnd(_d: Uint8Array): FwEnd {
  return { kind: 'fwEnd' };
}

export interface FwAck {
  kind: 'fwAck';
  /** FwStatus. */
  status: number;
  window: number;
  nextOffset: number;
}

export function encodeFwAck(addr: Address, m: Fields<FwAck>): TxFrame {
  const d = new Uint8Array(8);
  d[0] = m.status & 0xff;
  d[1] = m.window & 0xff;
  writeU32(d, 2, m.nextOffset);
  return frame(addr, Cls.FW_RSP, FwRsp.ACK, d);
}

export function decodeFwAck(d: Uint8Array): FwAck | null {
  if (d.length < 6) return null;
  return { kind: 'fwAck', status: d[0] ?? 0, window: d[1] ?? 0, nextOffset: readU32(d, 2) };
}

// ---------------------------------------------------------------------------------------
// CTRL formats. Which format a model uses is defined by its catalog `controls`.

/** Standard CTRL/0 SET: `[mode u8][flags u8][0 0][value f32]` (ESC, sealed servo). */
export interface CtrlSet {
  kind: 'ctrlSet';
  mode: number;
  flags: number;
  value: number;
}

export function encodeCtrlSet(addr: Address, m: Fields<CtrlSet>): TxFrame {
  const d = new Uint8Array(8);
  d[0] = m.mode & 0xff;
  d[1] = m.flags & 0xff;
  writeF32(d, 4, m.value);
  return frame(addr, Cls.CTRL, 0, d);
}

export function decodeCtrlSet(d: Uint8Array): CtrlSet | null {
  if (d.length < 8) return null;
  return { kind: 'ctrlSet', mode: d[0] ?? 0, flags: d[1] ?? 0, value: readF32(d, 4) };
}

/** 16-channel servo board: CTRL/index carries channels 4·index+1 .. 4·index+4 as µs (0 = off). */
export interface CtrlServo {
  kind: 'ctrlServo';
  index: number;
  pulsesUs: [number, number, number, number];
}

export function encodeCtrlServo(addr: Address, m: Fields<CtrlServo>): TxFrame {
  const d = new Uint8Array(8);
  for (let i = 0; i < 4; i++) writeU16(d, 2 * i, m.pulsesUs[i] ?? 0);
  return frame(addr, Cls.CTRL, m.index, d);
}

/** `index` comes from the CAN id (CTRL INDEX field). */
export function decodeCtrlServo(d: Uint8Array, index: number): CtrlServo | null {
  if (d.length < 8) return null;
  return { kind: 'ctrlServo', index, pulsesUs: [readU16(d, 0), readU16(d, 2), readU16(d, 4), readU16(d, 6)] };
}

/** Debug OLED CTRL/0 TEXT: `[line u8][col u8][6 ASCII]`; NUL bytes are not drawn. */
export interface CtrlText {
  kind: 'ctrlText';
  line: number;
  col: number;
  text: string;
}

export function encodeCtrlText(addr: Address, m: Fields<CtrlText>): TxFrame {
  const d = new Uint8Array(8);
  d[0] = m.line & 0xff;
  d[1] = m.col & 0xff;
  d.set(encodeAscii(m.text, 6), 2);
  return frame(addr, Cls.CTRL, 0, d);
}

export function decodeCtrlText(d: Uint8Array): CtrlText | null {
  if (d.length < 2) return null;
  return { kind: 'ctrlText', line: d[0] ?? 0, col: d[1] ?? 0, text: decodeAscii(d, 2, Math.min(8, d.length)) };
}

// ---------------------------------------------------------------------------------------
// Model-specific frames whose layout lives in the catalog.

export interface CtrlRaw {
  kind: 'ctrl';
  index: number;
  data: Uint8Array;
}

export interface StatusRaw {
  kind: 'status';
  index: number;
  data: Uint8Array;
}

export function statusFrameId(addr: Address, n: number): number {
  return messageId(addr, Cls.STATUS, n);
}

export function encodeStatus(addr: Address, m: Fields<StatusRaw>): TxFrame {
  return frame(addr, Cls.STATUS, m.index, m.data);
}

export function encodeCtrl(addr: Address, m: Fields<CtrlRaw>): TxFrame {
  return frame(addr, Cls.CTRL, m.index, m.data);
}

// ---------------------------------------------------------------------------------------
// Generic dispatch

/** Everything `decodeMessage` can return. CTRL and STATUS stay raw (layout is per model). */
export type DecodedMessage =
  | EnumReq
  | AssignId
  | Identify
  | IdentifyUid
  | InfoReq
  | NameSet
  | CommandReq
  | FaultReq
  | Estop
  | Heartbeat
  | InfoRsp
  | CommandRsp
  | FaultRsp
  | EnumRsp
  | ParamGet
  | ParamSet
  | ParamValue
  | StreamConfig
  | StreamStart
  | StreamStop
  | StreamData
  | FwBegin
  | FwData
  | FwEnd
  | FwAck
  | CtrlRaw
  | StatusRaw;

/** Everything `encodeMessage` accepts: decoded messages plus the typed CTRL formats. */
export type CyCanMessage = DecodedMessage | CtrlSet | CtrlServo | CtrlText;
export type MessageKind = CyCanMessage['kind'];

/**
 * Decodes the payload of a CyCAN frame by its class/index. Returns null for non-CyCAN
 * classes, unknown indexes and short payloads. Does not check MFR; use isCyCanId first.
 */
export function decodeMessage(id: number, data: Uint8Array): DecodedMessage | null {
  const index = idIndex(id);
  switch (idClass(id)) {
    case Cls.CTRL:
      return { kind: 'ctrl', index, data };
    case Cls.STATUS:
      return { kind: 'status', index, data };
    case Cls.SYS_REQ:
      switch (index) {
        case SysReq.ENUM_REQ:
          return decodeEnumReq(data);
        case SysReq.ASSIGN_ID:
          return decodeAssignId(data);
        case SysReq.IDENTIFY:
          return decodeIdentify(data);
        case SysReq.INFO_REQ:
          return decodeInfoReq(data);
        case SysReq.NAME_SET:
          return decodeNameSet(data);
        case SysReq.COMMAND:
          return decodeCommand(data);
        case SysReq.FAULT_REQ:
          return decodeFaultReq(data);
        case SysReq.ESTOP:
          return decodeEstop(data);
      }
      return null;
    case Cls.SYS_RSP:
      switch (index) {
        case SysRsp.HEARTBEAT:
          return decodeHeartbeat(data);
        case SysRsp.INFO_RSP:
          return decodeInfoRsp(data);
        case SysRsp.COMMAND_RSP:
          return decodeCommandRsp(data);
        case SysRsp.FAULT_RSP:
          return decodeFaultRsp(data);
      }
      return null;
    case Cls.ENUM_RSP:
      return decodeEnumRsp(data);
    case Cls.PARAM_REQ:
      if (index === ParamReq.GET) return decodeParamGet(data);
      if (index === ParamReq.SET) return decodeParamSet(data);
      return null;
    case Cls.PARAM_RSP:
      return index === ParamRsp.VALUE ? decodeParamValue(data) : null;
    case Cls.STREAM_REQ:
      if (index === StreamReq.CONFIG) return decodeStreamConfig(data);
      if (index === StreamReq.START) return decodeStreamStart(data);
      if (index === StreamReq.STOP) return decodeStreamStop(data);
      return null;
    case Cls.STREAM_RSP:
      return index === StreamRsp.DATA ? decodeStreamData(data) : null;
    case Cls.FW_REQ:
      if (index === FwReq.BEGIN) return decodeFwBegin(data);
      if (index === FwReq.DATA) return decodeFwData(data);
      if (index === FwReq.END) return decodeFwEnd(data);
      return null;
    case Cls.FW_RSP:
      return index === FwRsp.ACK ? decodeFwAck(data) : null;
  }
  return null;
}

/** Encodes any message; `addr` is the destination (requests) or sender (responses). */
export function encodeMessage(addr: Address, m: CyCanMessage): TxFrame {
  switch (m.kind) {
    case 'enumReq':
      return encodeEnumReq(addr, m);
    case 'assignId':
      return encodeAssignId(addr, m);
    case 'identify':
      return encodeIdentify(addr, m);
    case 'identifyUid':
      return encodeIdentifyUid(addr, m);
    case 'infoReq':
      return encodeInfoReq(addr, m);
    case 'nameSet':
      return encodeNameSet(addr, m);
    case 'command':
      return encodeCommand(addr, m);
    case 'faultReq':
      return encodeFaultReq(addr);
    case 'estop':
      return encodeEstop(addr);
    case 'heartbeat':
      return encodeHeartbeat(addr, m);
    case 'infoRsp':
      return encodeInfoRsp(addr, m);
    case 'commandRsp':
      return encodeCommandRsp(addr, m);
    case 'faultRsp':
      return encodeFaultRsp(addr, m);
    case 'enumRsp':
      return encodeEnumRsp(addr, m);
    case 'paramGet':
      return encodeParamGet(addr, m);
    case 'paramSet':
      return encodeParamSet(addr, m);
    case 'paramValue':
      return encodeParamValue(addr, m);
    case 'streamConfig':
      return encodeStreamConfig(addr, m);
    case 'streamStart':
      return encodeStreamStart(addr, m);
    case 'streamStop':
      return encodeStreamStop(addr);
    case 'streamData':
      return encodeStreamData(addr, m);
    case 'fwBegin':
      return encodeFwBegin(addr, m);
    case 'fwData':
      return encodeFwData(addr, m);
    case 'fwEnd':
      return encodeFwEnd(addr);
    case 'fwAck':
      return encodeFwAck(addr, m);
    case 'ctrl':
      return encodeCtrl(addr, m);
    case 'status':
      return encodeStatus(addr, m);
    case 'ctrlSet':
      return encodeCtrlSet(addr, m);
    case 'ctrlServo':
      return encodeCtrlServo(addr, m);
    case 'ctrlText':
      return encodeCtrlText(addr, m);
  }
}
