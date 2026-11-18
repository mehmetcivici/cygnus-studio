// Source of the golden vectors in cycan-vectors.json. Regenerate the JSON with
// `npx tsx tools/gen-vectors.ts`; test/vectors.test.ts checks the file matches this list.

import {
  BROADCAST_ALL,
  Command,
  CommandStatus,
  DeviceState,
  FwStatus,
  Model,
  PType,
  ParamStatus,
  buildCyfw,
  crc32,
  deriveUid,
  encodeAscii,
  encodeMessage,
  encodeName,
  encodeStatusFrame,
  f32ToBits,
  fromHex,
  getModel,
  toHex,
  type Address,
  type CyCanMessage,
} from '../../src';

export interface MessageCase {
  name: string;
  addr: Address;
  msg: CyCanMessage;
}

const ESC1: Address = { devType: 2, num: 1 };
const ENC5: Address = { devType: 7, num: 5 };
const SERVO3: Address = { devType: 12, num: 3 };
const OLED1: Address = { devType: 10, num: 1 };

const seq = (n: number, start = 0) => Uint8Array.from({ length: n }, (_, i) => (start + i) & 0xff);
const NAME = encodeName('Sol ön itici');

export const MESSAGE_CASES: MessageCase[] = [
  { name: 'enum_req_all', addr: BROADCAST_ALL, msg: { kind: 'enumReq', filter: 0 } },
  { name: 'enum_req_unassigned', addr: BROADCAST_ALL, msg: { kind: 'enumReq', filter: 1 } },
  { name: 'assign_id_persist', addr: BROADCAST_ALL, msg: { kind: 'assignId', uid48: 0x123456789abc, newNum: 5, persist: true } },
  { name: 'identify_addressed', addr: ESC1, msg: { kind: 'identify', seconds: 5 } },
  { name: 'identify_uid', addr: BROADCAST_ALL, msg: { kind: 'identifyUid', uid48: 0x4819416d7fb9, seconds: 10 } },
  { name: 'info_req_page0', addr: ESC1, msg: { kind: 'infoReq', page: 0 } },
  { name: 'name_set_page0', addr: ESC1, msg: { kind: 'nameSet', page: 0, bytes: NAME.slice(0, 7) } },
  { name: 'command_save_params', addr: ESC1, msg: { kind: 'command', cmd: Command.SAVE_PARAMS, arg: 0 } },
  { name: 'command_model_f32_arg', addr: ESC1, msg: { kind: 'command', cmd: 0x43, arg: f32ToBits(1.5) } },
  { name: 'fault_req', addr: ESC1, msg: { kind: 'faultReq' } },
  { name: 'estop_broadcast', addr: BROADCAST_ALL, msg: { kind: 'estop' } },
  {
    name: 'heartbeat_active',
    addr: ESC1,
    msg: {
      kind: 'heartbeat',
      state: DeviceState.ACTIVE,
      unsaved: true,
      enabled: true,
      warning: false,
      identify: false,
      fault: 0x0010,
      uid16: 0xbeef,
      fwMajor: 1,
      fwMinor: 2,
      fwPatch: 3,
    },
  },
  {
    name: 'heartbeat_conflict_flags',
    addr: ENC5,
    msg: {
      kind: 'heartbeat',
      state: DeviceState.FAULT,
      unsaved: false,
      enabled: false,
      warning: true,
      identify: true,
      fault: 0x8421,
      uid16: 0x0102,
      fwMajor: 0,
      fwMinor: 9,
      fwPatch: 255,
    },
  },
  {
    name: 'info_rsp_device',
    addr: ESC1,
    msg: {
      kind: 'infoRsp',
      section: 'device',
      page: 0,
      model: Model.ESC_20A,
      hwRev: 3,
      protoMajor: 1,
      protoMinor: 0,
      catalogRev: 0x0102,
      bootloaderVer: 2,
    },
  },
  { name: 'info_rsp_uid_lo', addr: ESC1, msg: { kind: 'infoRsp', section: 'bytes', page: 1, bytes: seq(7) } },
  { name: 'info_rsp_uid_hi', addr: ESC1, msg: { kind: 'infoRsp', section: 'bytes', page: 2, bytes: Uint8Array.of(7, 8, 9, 10, 11, 0, 0) } },
  { name: 'info_rsp_build', addr: ESC1, msg: { kind: 'infoRsp', section: 'build', page: 3, gitHash: 0xdeadbeef, buildDay: 321, dirty: true } },
  { name: 'info_rsp_name0', addr: ESC1, msg: { kind: 'infoRsp', section: 'bytes', page: 4, bytes: NAME.slice(0, 7) } },
  { name: 'command_rsp_in_progress', addr: ESC1, msg: { kind: 'commandRsp', cmd: Command.SELF_TEST, status: CommandStatus.IN_PROGRESS, result: 0 } },
  { name: 'command_rsp_ok_result', addr: ESC1, msg: { kind: 'commandRsp', cmd: Command.SELF_TEST, status: CommandStatus.OK, result: 0x00000012 } },
  { name: 'fault_rsp', addr: ESC1, msg: { kind: 'faultRsp', active: 0x0401, sticky: 0x0409, warn: 0x0010 } },
  { name: 'enum_rsp_conflict', addr: ENC5, msg: { kind: 'enumRsp', uid48: 0x4819416d7fb9, num: 5, conflict: true, bootloader: false, model: Model.CYNCODER } },
  { name: 'enum_rsp_unassigned_bootloader', addr: ESC1, msg: { kind: 'enumRsp', uid48: 0x07ac04e44e33, num: 63, conflict: false, bootloader: true, model: Model.ESC_80A } },
  { name: 'param_get', addr: ESC1, msg: { kind: 'paramGet', pid: 0x0160 } },
  { name: 'param_set_f32', addr: ESC1, msg: { kind: 'paramSet', pid: 0x0160, ptype: PType.F32, value: 0.25 } },
  { name: 'param_set_u32', addr: ESC1, msg: { kind: 'paramSet', pid: 0x0003, ptype: PType.U32, value: 250 } },
  { name: 'param_set_i32', addr: ESC1, msg: { kind: 'paramSet', pid: 0x0200, ptype: PType.I32, value: -5 } },
  { name: 'param_set_bool', addr: ESC1, msg: { kind: 'paramSet', pid: 0x0101, ptype: PType.BOOL, value: 1 } },
  { name: 'param_set_enum', addr: ESC1, msg: { kind: 'paramSet', pid: 0x0001, ptype: PType.ENUM, value: 3 } },
  { name: 'param_value_ok', addr: ESC1, msg: { kind: 'paramValue', pid: 0x0160, ptype: PType.F32, status: ParamStatus.OK, value: 0.25 } },
  { name: 'param_value_out_of_range', addr: ESC1, msg: { kind: 'paramValue', pid: 0x0003, ptype: PType.U32, status: ParamStatus.OUT_OF_RANGE, value: 200 } },
  { name: 'stream_config', addr: ESC1, msg: { kind: 'streamConfig', slot: 2, sid: 5 } },
  { name: 'stream_config_clear', addr: ESC1, msg: { kind: 'streamConfig', slot: 14, sid: 0xffff } },
  { name: 'stream_start_1ms', addr: ESC1, msg: { kind: 'streamStart', period100us: 10 } },
  { name: 'stream_stop', addr: ESC1, msg: { kind: 'streamStop' } },
  { name: 'stream_data_classic', addr: ESC1, msg: { kind: 'streamData', seq: 200, firstSlot: 3, t100us: 0xfffe, values: [-1234.5] } },
  { name: 'stream_data_fd_3', addr: ESC1, msg: { kind: 'streamData', seq: 7, firstSlot: 0, t100us: 1000, values: [1.5, -2, 1024] } },
  { name: 'fw_begin', addr: ESC1, msg: { kind: 'fwBegin', size: 0x00012345, crc32: 0xcafebabe } },
  { name: 'fw_data_classic', addr: ESC1, msg: { kind: 'fwData', offset: 0x000100, bytes: seq(5, 0xa0) } },
  { name: 'fw_data_fd', addr: ESC1, msg: { kind: 'fwData', offset: 0x012340, bytes: seq(61, 1) } },
  { name: 'fw_end', addr: ESC1, msg: { kind: 'fwEnd' } },
  { name: 'fw_ack_bad_offset', addr: ESC1, msg: { kind: 'fwAck', status: FwStatus.BAD_OFFSET, window: 16, nextOffset: 0x000105 } },
  { name: 'ctrl_set_velocity', addr: ESC1, msg: { kind: 'ctrlSet', mode: 3, flags: 0, value: 1500 } },
  { name: 'ctrl_servo_ch5_8', addr: SERVO3, msg: { kind: 'ctrlServo', index: 1, pulsesUs: [1000, 1500, 2000, 0] } },
  { name: 'ctrl_text', addr: OLED1, msg: { kind: 'ctrlText', line: 2, col: 4, text: 'V=12.4' } },
];

export const UID_CASES: string[] = ['000102030405060708090a0b', '20003a001251333038373439', 'ffffffffffffffffffffffff'];

export interface StatusCase {
  name: string;
  model: number;
  frame: number;
  values: Record<string, number>;
}

export const STATUS_CASES: StatusCase[] = [
  { name: 'esc20a_fast', model: Model.ESC_20A, frame: 0, values: { velocity: 1234.5, 'phase.current': -12.34, duty: 0.5 } },
  { name: 'esc20a_position_supply', model: Model.ESC_20A, frame: 1, values: { position: -3.25, 'bus.voltage': 12.6, 'bus.current': 4.2 } },
  {
    name: 'cyncoder_abs_magnet',
    model: Model.CYNCODER,
    frame: 1,
    values: { 'abs.position': 0.75, 'raw.angle': 3071, 'magnet.status': 1, 'magnet.agc': 180, temp: -5 },
  },
  { name: 'gyro_quaternion', model: Model.GYRO, frame: 3, values: { 'quat.w': 1, 'quat.x': 0, 'quat.y': -0.5, 'quat.z': 0.25 } },
  {
    name: 'pdh_large_totals',
    model: Model.POWER_DIST_LARGE,
    frame: 2,
    values: { 'input.voltage': 12.48, 'total.current': 85.5, power: 1067, 'fuse.mask': 0x05, temp: 41 },
  },
];

const hexId = (id: number) => `0x${id.toString(16).padStart(8, '0')}`;

/** Converts Uint8Array fields to hex strings for JSON. */
export function jsonFields(msg: CyCanMessage): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(msg)) out[k] = v instanceof Uint8Array ? toHex(v) : v;
  return out;
}

/** Inverse of jsonFields: the only byte-array field name used by messages is `bytes`. */
export function messageFromJson(fields: Record<string, unknown>): CyCanMessage {
  const out: Record<string, unknown> = { ...fields };
  if (typeof out.bytes === 'string') out.bytes = fromHex(out.bytes);
  return out as unknown as CyCanMessage;
}

export function buildVectors() {
  const messages = MESSAGE_CASES.map((c) => {
    const f = encodeMessage(c.addr, c.msg);
    return { name: c.name, kind: c.msg.kind, addr: c.addr, id: hexId(f.id), data: toHex(f.data), fd: f.fd, fields: jsonFields(c.msg) };
  });
  const uids = UID_CASES.map((hex) => {
    const d = deriveUid(fromHex(hex) ?? new Uint8Array(12));
    return { uid96: hex, uid48: d.uid48, uid48Hex: `0x${d.uid48.toString(16).padStart(12, '0')}`, uid16: d.uid16, hash10: d.hash10, enumDelayMs: d.enumDelayMs };
  });
  const status = STATUS_CASES.map((c) => {
    const def = getModel(c.model);
    const frame = def?.statusFrames.find((f) => f.index === c.frame);
    if (!def || !frame) throw new Error(`no status frame ${c.model}/${c.frame}`);
    return { name: c.name, model: c.model, frame: c.frame, values: c.values, data: toHex(encodeStatusFrame(frame, c.values)) };
  });
  const crcInputs = ['123456789', '', 'CyCAN'];
  const crc = crcInputs.map((s) => ({ ascii: s, crc32: `0x${crc32(encodeAscii(s, s.length)).toString(16).padStart(8, '0')}` }));
  const cyfwMeta = {
    model: Model.CYNCODER,
    hwRevMin: 1,
    hwRevMax: 2,
    fwMajor: 1,
    fwMinor: 5,
    fwPatch: 0,
    catalogRev: 1,
    gitHash: 0x1234abcd,
    buildDay: 300,
    name: 'cyncoder-1.5.0',
  };
  const cyfwFile = buildCyfw(cyfwMeta, seq(16));
  return {
    format: 'cycan-vectors',
    version: 1,
    protocol: '1.0',
    notes:
      'Generated by tools/gen-vectors.ts from packages/protocol/test/vectors/cases.ts. ' +
      'id is the 29-bit CAN id; data is the full payload (FD frames already padded); byte-array fields are hex; ' +
      'f32 values are exactly representable. addr is the destination for requests and the sender for responses.',
    messages,
    uid: uids,
    crc32: crc,
    statusFrames: status,
    cyfw: { meta: cyfwMeta, payload: toHex(seq(16)), file: toHex(cyfwFile) },
  };
}
