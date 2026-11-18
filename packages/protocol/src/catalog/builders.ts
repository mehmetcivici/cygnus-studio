import { PType } from '../core/constants';
import type { EnumOption, ParamDef, SignalDef, Text } from './schema';

// Terse constructors so the model files read like tables. Labels and help are [tr, en].

export type TrEn = readonly [string, string];

export const tx = (t: TrEn): Text => ({ tr: t[0], en: t[1] });

export function opts(...items: ReadonlyArray<readonly [number, string, string]>): EnumOption[] {
  return items.map(([value, tr, en]) => ({ value, label: { tr, en } }));
}

type Flags = Pick<ParamDef, 'readOnly' | 'rebootRequired' | 'lockedWhileEnabled' | 'advanced' | 'minNonZero'>;

interface NumOpts extends Flags {
  unit?: string;
  min: number;
  max: number;
  step?: number;
  def: number;
  digits?: number;
}

function digitsOf(step: number): number {
  if (Number.isInteger(step)) return 0;
  const s = step.toString();
  const e = s.indexOf('e-');
  if (e >= 0) return Number(s.slice(e + 2));
  return s.length - s.indexOf('.') - 1;
}

function flagsOf(o: Flags): Flags {
  const f: Flags = {};
  if (o.readOnly) f.readOnly = true;
  if (o.rebootRequired) f.rebootRequired = true;
  if (o.lockedWhileEnabled) f.lockedWhileEnabled = true;
  if (o.advanced) f.advanced = true;
  if (o.minNonZero !== undefined) f.minNonZero = o.minNonZero;
  return f;
}

function numeric(ptype: PType, pid: number, key: string, group: string, label: TrEn, help: TrEn, o: NumOpts): ParamDef {
  const step = o.step ?? (ptype === PType.F32 ? 0.01 : 1);
  return {
    pid,
    key,
    ptype,
    unit: o.unit ?? '',
    min: o.min,
    max: o.max,
    step,
    default: o.def,
    digits: o.digits ?? digitsOf(step),
    group,
    label: tx(label),
    help: tx(help),
    ...flagsOf(o),
  };
}

export const pF32 = (pid: number, key: string, group: string, label: TrEn, help: TrEn, o: NumOpts): ParamDef =>
  numeric(PType.F32, pid, key, group, label, help, o);

export const pU32 = (pid: number, key: string, group: string, label: TrEn, help: TrEn, o: NumOpts): ParamDef =>
  numeric(PType.U32, pid, key, group, label, help, o);

export const pI32 = (pid: number, key: string, group: string, label: TrEn, help: TrEn, o: NumOpts): ParamDef =>
  numeric(PType.I32, pid, key, group, label, help, o);

export function pBool(pid: number, key: string, group: string, label: TrEn, help: TrEn, def: boolean, f: Flags = {}): ParamDef {
  return {
    pid,
    key,
    ptype: PType.BOOL,
    unit: '',
    min: 0,
    max: 1,
    step: 1,
    default: def ? 1 : 0,
    digits: 0,
    group,
    label: tx(label),
    help: tx(help),
    ...flagsOf(f),
  };
}

export function pEnum(
  pid: number,
  key: string,
  group: string,
  label: TrEn,
  help: TrEn,
  options: EnumOption[],
  def: number,
  f: Flags = {},
): ParamDef {
  const values = options.map((o) => o.value);
  return {
    pid,
    key,
    ptype: PType.ENUM,
    unit: '',
    min: Math.min(...values),
    max: Math.max(...values),
    step: 1,
    default: def,
    digits: 0,
    group,
    label: tx(label),
    help: tx(help),
    options,
    ...flagsOf(f),
  };
}

export function sig(
  sid: number,
  key: string,
  unit: string,
  label: TrEn,
  range: [number, number],
  digits: number,
  extra: Pick<SignalDef, 'options' | 'bits'> = {},
): SignalDef {
  return { sid, key, unit, label: tx(label), range, digits, ...extra };
}
