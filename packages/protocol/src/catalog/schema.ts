import type { PType } from '../core/constants';

/** Every user-visible string carries Turkish (default) and English. */
export interface Text {
  tr: string;
  en: string;
}

export interface EnumOption {
  value: number;
  label: Text;
}

export interface GroupDef {
  key: string;
  label: Text;
}

export interface ParamDef {
  pid: number;
  /** Dotted key, unique within the model, e.g. `vel.kp`. */
  key: string;
  ptype: PType;
  /** Physical unit shown next to the value ('' when unitless). */
  unit: string;
  min: number;
  max: number;
  step: number;
  default: number;
  /** When set, values in (0, minNonZero) are invalid: 0 means "off". */
  minNonZero?: number;
  /** Digits shown after the decimal point. */
  digits: number;
  group: string;
  label: Text;
  help: Text;
  /** Required for enum parameters. */
  options?: EnumOption[];
  readOnly?: boolean;
  rebootRequired?: boolean;
  lockedWhileEnabled?: boolean;
  advanced?: boolean;
}

export interface SignalDef {
  sid: number;
  key: string;
  unit: string;
  label: Text;
  /** Default display range. */
  range: [number, number];
  digits: number;
  /** Discrete signals (states) list their values. */
  options?: EnumOption[];
  /** Bit mask signal: per-bit labels (e.g. blown fuses). */
  bits?: Text[];
}

export type StatusFieldType = 'u8' | 'i8' | 'u16' | 'i16' | 'u24' | 'i24' | 'u32' | 'i32' | 'f32';

export interface StatusFieldDef {
  /** Signal key this field carries. */
  signal: string;
  /** Byte offset of the containing integer within the 8-byte frame. */
  byte: number;
  type: StatusFieldType;
  /** Optional bit field inside the integer: starting bit and width. */
  bit?: number;
  bits?: number;
  /** physical = raw × scale + bias (ignored for f32). */
  scale?: number;
  bias?: number;
}

export interface StatusFrameDef {
  /** STATUS INDEX (0..15). */
  index: number;
  label: Text;
  defaultPeriodMs: number;
  fields: StatusFieldDef[];
}

export interface ControlModeDef {
  value: number;
  key: string;
  label: Text;
  unit: string;
  /** Range of the setpoint value; modes without a setpoint use 0..0. */
  min: number;
  max: number;
  /** Signal that shows the controlled quantity, if any. */
  measured?: string;
}

/** `set`: `[mode][flags][0 0][value f32]` · `servo4`: 4 × u16 µs · `text`: `[line][col][6 ASCII]`. */
export type ControlFormat = 'set' | 'servo4' | 'text';

export interface ControlFrameDef {
  index: number;
  key: string;
  label: Text;
  format: ControlFormat;
  /** `set` format: available modes. */
  modes?: ControlModeDef[];
  /** `servo4` format: first channel number (1-based) carried by this frame. */
  firstChannel?: number;
}

export interface ActionArgDef {
  ptype: PType;
  label: Text;
  unit: string;
  min: number;
  max: number;
  default: number;
}

export interface ActionDef {
  /** COMMAND code, 0x40..0xFF. */
  cmd: number;
  key: string;
  label: Text;
  help: Text;
  arg?: ActionArgDef;
  /** Board answers IN_PROGRESS first, then OK/FAILED. */
  longRunning?: boolean;
  /** Ask the user before running (moves actuators or rewrites settings). */
  confirm?: boolean;
}

export interface BitDef {
  bit: number;
  key: string;
  label: Text;
  help?: Text;
}

export type GainRole = 'kp' | 'ki' | 'kd' | 'kS' | 'kV' | 'kA' | 'iMax' | 'outMax';

export interface TunerLoopDef {
  key: string;
  label: Text;
  /** CTRL frame index and mode that run this loop. */
  ctrlFrame: number;
  mode: number;
  /** Unit of target / measured / error. */
  unit: string;
  /** Parameter keys of the loop gains by role. */
  gains: Partial<Record<GainRole, string>>;
  /** Other parameters worth showing next to the gains (filters, profile limits). */
  extraParams?: string[];
  signals: { target: string; measured: string; output: string; error: string };
}

export type ModelCategory = 'motor' | 'sensor' | 'servo' | 'power' | 'tool';

export interface ModelDef {
  model: number;
  devType: number;
  /** Short identifier, e.g. `esc20a`; used for generated C names. */
  key: string;
  name: Text;
  category: ModelCategory;
  catalogRev: number;
  description: Text;
  groups: GroupDef[];
  params: ParamDef[];
  signals: SignalDef[];
  statusFrames: StatusFrameDef[];
  controls: ControlFrameDef[];
  actions: ActionDef[];
  /** Model-specific fault bits (10..15). */
  faults: BitDef[];
  selfTestBits: BitDef[];
  stream: { minPeriodUs: number };
  tuner: { loops: TunerLoopDef[] };
}
