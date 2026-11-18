import { CLASSIC_MAX_LEN, Cls, DevType, FD_MAX_LEN, LEGACY_CLASS_MAX, MFR, decodeId, encodeId, isToDeviceClass, isValidFdLength, type CanIdFields } from '@cygnus/protocol';

export type FrameKind = 'cycan' | 'legacy' | 'foreign';

/** Our manufacturer with an API class above the legacy range is CyCAN; class 0..15 is the old Cyncoder protocol. */
export function frameKind(id: number): FrameKind {
  const f = decodeId(id);
  if (f.mfr !== MFR) return 'foreign';
  return f.cls <= LEGACY_CLASS_MAX ? 'legacy' : 'cycan';
}

export const CLASS_NAMES: Readonly<Record<number, string>> = {
  [Cls.CTRL]: 'CTRL',
  [Cls.STATUS]: 'STATUS',
  [Cls.SYS_REQ]: 'SYS_REQ',
  [Cls.SYS_RSP]: 'SYS_RSP',
  [Cls.PARAM_REQ]: 'PARAM_REQ',
  [Cls.PARAM_RSP]: 'PARAM_RSP',
  [Cls.STREAM_REQ]: 'STREAM_REQ',
  [Cls.STREAM_RSP]: 'STREAM_RSP',
  [Cls.FW_REQ]: 'FW_REQ',
  [Cls.FW_RSP]: 'FW_RSP',
  [Cls.ENUM_RSP]: 'ENUM_RSP',
};

export const KNOWN_CLASSES: readonly number[] = Object.keys(CLASS_NAMES).map(Number);

export const DEVTYPE_CHOICES: ReadonlyArray<{ value: number; name: string }> = [
  { value: DevType.BROADCAST, name: 'BROADCAST' },
  { value: DevType.MOTOR_CONTROLLER, name: 'MOTOR' },
  { value: DevType.GYRO, name: 'GYRO' },
  { value: DevType.ENCODER, name: 'ENCODER' },
  { value: DevType.POWER_DISTRIBUTION, name: 'POWER' },
  { value: DevType.MISC, name: 'MISC' },
  { value: DevType.SERVO_CONTROLLER, name: 'SERVO' },
];

/** Short class name for filters and colouring: `STATUS`, `0x1F`, `LEGACY/1` or `MFR 5`. */
export function classLabel(id: number): string {
  const f = decodeId(id);
  if (f.mfr !== MFR) return `MFR ${f.mfr}`;
  if (f.cls <= LEGACY_CLASS_MAX) return `LEGACY/${f.cls}`;
  return CLASS_NAMES[f.cls] ?? `0x${f.cls.toString(16).toUpperCase().padStart(2, '0')}`;
}

/** Key for grouping by class: the class number, -1 legacy, -2 foreign. */
export function classBucket(id: number): number {
  const k = frameKind(id);
  return k === 'foreign' ? -2 : k === 'legacy' ? -1 : decodeId(id).cls;
}

export const idHex = (id: number): string => (id >>> 0).toString(16).toUpperCase().padStart(8, '0');

export const bytesHex = (d: Uint8Array, sep = ' '): string => Array.from(d, (b) => b.toString(16).toUpperCase().padStart(2, '0')).join(sep);

/** `0x18080C41`, `18080c41`, `18 08 0C 41` → id; null when not a valid 29-bit identifier. */
export function parseHexId(text: string): number | null {
  const s = text.trim().replace(/^0x/i, '').replace(/[\s_]/g, '');
  if (!/^[0-9a-f]{1,8}$/i.test(s)) return null;
  const v = parseInt(s, 16);
  return v <= 0x1fffffff ? v : null;
}

/** `01 02 0a`, `0102`, `0x01,0x02` → bytes; null for odd digit counts or non-hex. */
export function parseDataHex(text: string): Uint8Array | null {
  const s = text.replace(/0x/gi, '').replace(/[\s,_:-]/g, '');
  if (s.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(s)) return null;
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export type FieldKey = keyof CanIdFields;

export const FIELD_BITS: Readonly<Record<FieldKey, { hi: number; lo: number }>> = {
  devType: { hi: 28, lo: 24 },
  mfr: { hi: 23, lo: 16 },
  cls: { hi: 15, lo: 10 },
  index: { hi: 9, lo: 6 },
  num: { hi: 5, lo: 0 },
};
export const FIELD_ORDER: readonly FieldKey[] = ['devType', 'mfr', 'cls', 'index', 'num'];

const fieldMax = (k: FieldKey): number => (1 << (FIELD_BITS[k].hi - FIELD_BITS[k].lo + 1)) - 1;

/** Fields that do not fit their bit width (the id builder flags them instead of masking silently). */
export function invalidFields(f: CanIdFields): FieldKey[] {
  return FIELD_ORDER.filter((k) => !Number.isInteger(f[k]) || f[k] < 0 || f[k] > fieldMax(k));
}

/** Builds the 29-bit identifier from its fields. */
export function composeId(f: CanIdFields): number {
  return encodeId({ devType: f.devType, mfr: f.mfr, cls: f.cls, index: f.index, num: f.num });
}

export interface BitSegment {
  key: FieldKey;
  hi: number;
  lo: number;
  value: number;
  /** Binary digits of the field, MSB first. */
  bits: string;
}

/** The identifier split into its five fields with their bit ranges (for the bit map). */
export function idSegments(id: number): BitSegment[] {
  const f = decodeId(id);
  return FIELD_ORDER.map((key) => {
    const { hi, lo } = FIELD_BITS[key];
    return { key, hi, lo, value: f[key], bits: f[key].toString(2).padStart(hi - lo + 1, '0') };
  });
}

export type SendRisk = 'ctrl' | 'broadcast' | 'foreign';

/**
 * Why sending this id needs an explicit confirmation: CTRL frames drive actuators, broadcasts
 * reach every board (ESTOP is the one safe broadcast), and frames outside CyCAN have unknown
 * effects on whatever else is on the bus.
 */
export function sendRisks(id: number): SendRisk[] {
  const f = decodeId(id);
  if (frameKind(id) !== 'cycan') return ['foreign'];
  const risks: SendRisk[] = [];
  if (f.cls === Cls.CTRL) risks.push('ctrl');
  const estop = f.cls === Cls.SYS_REQ && f.index === 7;
  if (isToDeviceClass(f.cls) && f.num === 0 && !estop) risks.push('broadcast');
  return risks;
}

export type SendError = 'badId' | 'badData' | 'tooLong' | 'fdLength';

export type ParsedSend = { ok: true; frame: { id: number; data: Uint8Array; fd: boolean; brs: boolean } } | { ok: false; error: SendError };

/** Validates the raw send form: identifier, payload hex and the FD length rules. */
export function parseSend(idText: string, dataText: string, fd: boolean, brs: boolean): ParsedSend {
  const id = parseHexId(idText);
  if (id === null) return { ok: false, error: 'badId' };
  const data = parseDataHex(dataText);
  if (!data) return { ok: false, error: 'badData' };
  if (!fd && data.length > CLASSIC_MAX_LEN) return { ok: false, error: 'tooLong' };
  if (fd && data.length > FD_MAX_LEN) return { ok: false, error: 'tooLong' };
  if (fd && !isValidFdLength(data.length)) return { ok: false, error: 'fdLength' };
  return { ok: true, frame: { id, data, fd, brs: fd && brs } };
}
