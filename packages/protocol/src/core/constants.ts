// CyCAN v1 constants. Every value here mirrors docs/PROTOCOL.md; keep them in lockstep.

export const PROTO_MAJOR = 1;
export const PROTO_MINOR = 0;

/** Manufacturer code in bits 23..16 ("Team Use" until an official FRC code is assigned). */
export const MFR = 8;

export const NUM_BROADCAST = 0;
export const NUM_MIN = 1;
export const NUM_MAX = 62;
export const NUM_UNASSIGNED = 63;

/** FRC device types used by Cygnus boards (bits 28..24). */
export const DevType = {
  BROADCAST: 0,
  MOTOR_CONTROLLER: 2,
  GYRO: 4,
  ENCODER: 7,
  POWER_DISTRIBUTION: 8,
  MISC: 10,
  SERVO_CONTROLLER: 12,
} as const;
export type DevType = (typeof DevType)[keyof typeof DevType];

/** Product-family-wide 8-bit model code; selects the catalog entry. */
export const Model = {
  ESC_20A: 1,
  ESC_80A: 2,
  CYNCODER: 3,
  GYRO: 4,
  SERVO_16CH: 5,
  SEALED_SERVO: 6,
  POWER_DIST_SMALL: 7,
  POWER_DIST_LARGE: 8,
  SOC_REGULATOR: 9,
  DEBUG_OLED: 10,
  USB_CAN: 11,
} as const;
export type Model = (typeof Model)[keyof typeof Model];

/** API class (bits 15..10). Even = host to board, odd = board to host. */
export const Cls = {
  CTRL: 0x10,
  STATUS: 0x11,
  SYS_REQ: 0x12,
  SYS_RSP: 0x13,
  PARAM_REQ: 0x14,
  PARAM_RSP: 0x15,
  STREAM_REQ: 0x16,
  STREAM_RSP: 0x17,
  FW_REQ: 0x18,
  FW_RSP: 0x19,
  ENUM_RSP: 0x1b,
} as const;
export type Cls = (typeof Cls)[keyof typeof Cls];

/** Classes 0x00..0x0F belong to the legacy Cyncoder v3 protocol (PROTOCOL §11). */
export const LEGACY_CLASS_MAX = 0x0f;

export const SysReq = {
  ENUM_REQ: 0,
  ASSIGN_ID: 1,
  IDENTIFY: 2,
  INFO_REQ: 3,
  NAME_SET: 4,
  COMMAND: 5,
  FAULT_REQ: 6,
  ESTOP: 7,
} as const;

export const SysRsp = {
  HEARTBEAT: 0,
  INFO_RSP: 3,
  COMMAND_RSP: 5,
  FAULT_RSP: 6,
} as const;

export const ParamReq = { GET: 0, SET: 1 } as const;
export const ParamRsp = { VALUE: 0 } as const;
export const StreamReq = { CONFIG: 0, START: 1, STOP: 2 } as const;
export const StreamRsp = { DATA: 0 } as const;
export const FwReq = { BEGIN: 0, DATA: 1, END: 2 } as const;
export const FwRsp = { ACK: 0 } as const;

export const EnumFilter = { ALL: 0, UNASSIGNED_OR_CONFLICT: 1 } as const;

export const DeviceState = {
  BOOT: 0,
  BOOTLOADER: 1,
  IDLE: 2,
  ACTIVE: 3,
  FAULT: 4,
  ESTOP: 5,
} as const;
export type DeviceState = (typeof DeviceState)[keyof typeof DeviceState];

/** HEARTBEAT state_flags bits above the 4-bit state field. */
export const StateFlag = {
  UNSAVED: 1 << 4,
  ENABLED: 1 << 5,
  WARNING: 1 << 6,
  IDENTIFY: 1 << 7,
} as const;

/** ENUM_RSP num_flags bits above the 6-bit NUM field. */
export const EnumFlag = {
  CONFLICT: 1 << 6,
  BOOTLOADER: 1 << 7,
} as const;

/** Common fault bit numbers (PROTOCOL §4.6); bits 10..15 are model specific. */
export const FaultBit = {
  UNDERVOLT: 0,
  OVERVOLT: 1,
  OVERCURRENT: 2,
  OVERTEMP: 3,
  CTRL_TIMEOUT: 4,
  SENSOR: 5,
  HARDWARE: 6,
  PARAM_CRC: 7,
  CAN_ERR: 8,
  ESTOP: 9,
} as const;
export const MODEL_FAULT_BIT_MIN = 10;
export const MODEL_FAULT_BIT_MAX = 15;

export const Command = {
  REBOOT: 1,
  ENTER_BOOTLOADER: 2,
  SAVE_PARAMS: 3,
  LOAD_DEFAULTS: 4,
  CLEAR_FAULTS: 5,
  SELF_TEST: 6,
  CLEAR_ESTOP: 7,
} as const;
/** First model-specific command code (catalog `actions`). */
export const MODEL_COMMAND_MIN = 0x40;

export const CommandStatus = {
  OK: 0,
  IN_PROGRESS: 1,
  UNSUPPORTED: 2,
  INVALID_ARG: 3,
  DENIED: 4,
  FAILED: 5,
} as const;
export type CommandStatus = (typeof CommandStatus)[keyof typeof CommandStatus];

export const PType = { U32: 0, I32: 1, F32: 2, BOOL: 3, ENUM: 4 } as const;
export type PType = (typeof PType)[keyof typeof PType];

export const ParamStatus = {
  OK: 0,
  UNKNOWN_PARAM: 1,
  TYPE_MISMATCH: 2,
  OUT_OF_RANGE: 3,
  READ_ONLY: 4,
  DENIED_WHILE_ENABLED: 5,
} as const;
export type ParamStatus = (typeof ParamStatus)[keyof typeof ParamStatus];

export const FwStatus = {
  OK: 0,
  BUSY: 1,
  BAD_OFFSET: 2,
  BAD_CRC: 3,
  BAD_IMAGE: 4,
  FLASH_ERROR: 5,
  WRONG_STATE: 6,
} as const;
export type FwStatus = (typeof FwStatus)[keyof typeof FwStatus];

export const InfoPage = {
  DEVICE: 0,
  UID_LO: 1,
  UID_HI: 2,
  BUILD: 3,
  NAME_0: 4,
  NAME_1: 5,
  NAME_2: 6,
} as const;
export const NAME_BYTES = 21;

export const ESTOP_MAGIC_0 = 0xe5;
export const ESTOP_MAGIC_1 = 0x70;

/** `can.data_bitrate` enum values. */
export const DataBitrate = { CLASSIC: 0, M2: 1, M5: 2, M8: 3 } as const;
export type DataBitrate = (typeof DataBitrate)[keyof typeof DataBitrate];

/** Common parameter ids (PROTOCOL §5). */
export const CommonPid = {
  CAN_DATA_BITRATE: 0x0001,
  CAN_TERMINATION: 0x0002,
  CTRL_TIMEOUT_MS: 0x0003,
  STATUS_PERIOD_BASE: 0x0010,
} as const;
export const MODEL_PID_MIN = 0x0100;

export const STREAM_SLOTS = 15;
export const STREAM_SID_CLEAR = 0xffff;
export const FW_WINDOW_DEFAULT = 16;
export const FW_CHUNK_CLASSIC = 5;
export const FW_CHUNK_FD = 61;

/** Timing contract (PROTOCOL §10), milliseconds. */
export const Timing = {
  HEARTBEAT_MS: 500,
  HEARTBEAT_PHASE_MAX_MS: 50,
  LOST_AFTER_MS: 1500,
  ENUM_WINDOW_MS: 150,
  ENUM_SCAN_MS: 1000,
  REQUEST_TIMEOUT_MS: 100,
  REQUEST_RETRIES: 3,
  STREAM_KEEPALIVE_MS: 1000,
  STREAM_TIMEOUT_MS: 2000,
  CTRL_TIMEOUT_DEFAULT_MS: 200,
} as const;
