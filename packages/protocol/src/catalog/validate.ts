import {
  CommonPid,
  MODEL_COMMAND_MIN,
  MODEL_FAULT_BIT_MAX,
  MODEL_FAULT_BIT_MIN,
  MODEL_PID_MIN,
  PType,
  STREAM_SID_CLEAR,
} from '../core/constants';
import { CATALOG } from './catalog';
import { statusPeriodKey, statusPeriodPid } from './common';
import type { BitDef, ModelDef, ParamDef, Text } from './schema';
import { FIELD_SIZE, STATUS_FRAME_BYTES } from './status';
import { checkParamValue } from './values';

export interface CatalogIssue {
  model: string;
  path: string;
  message: string;
}

const VALID_PTYPES = new Set<number>(Object.values(PType));
const VALID_DEVTYPES = new Set([2, 4, 7, 8, 10, 12]);
const KEY_RE = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/;

function textOk(t: Text | undefined): boolean {
  return !!t && t.tr.trim().length > 0 && t.en.trim().length > 0;
}

/** Checks one model definition; returns an empty list when it is consistent. */
export function validateModel(def: ModelDef): CatalogIssue[] {
  const issues: CatalogIssue[] = [];
  const add = (path: string, message: string) => issues.push({ model: def.key, path, message });

  if (def.model < 1 || def.model > 255) add('model', 'model code must be 1..255');
  if (!VALID_DEVTYPES.has(def.devType)) add('devType', `unexpected DEVTYPE ${def.devType}`);
  if (!/^[a-z][a-z0-9_]*$/.test(def.key)) add('key', 'model key must be lower_snake');
  if (!textOk(def.name)) add('name', 'name needs tr and en');
  if (!textOk(def.description)) add('description', 'description needs tr and en');
  if (def.catalogRev < 1 || def.catalogRev > 0xffff) add('catalogRev', 'catalogRev must be 1..65535');

  const groups = new Set<string>();
  for (const g of def.groups) {
    if (groups.has(g.key)) add(`groups.${g.key}`, 'duplicate group');
    groups.add(g.key);
    if (!textOk(g.label)) add(`groups.${g.key}`, 'group label needs tr and en');
  }

  // Parameters
  const pids = new Set<number>();
  const pkeys = new Set<string>();
  for (const p of def.params) {
    const at = `params.${p.key}`;
    if (pids.has(p.pid)) add(at, `duplicate pid 0x${p.pid.toString(16)}`);
    pids.add(p.pid);
    if (pkeys.has(p.key)) add(at, 'duplicate key');
    pkeys.add(p.key);
    if (!KEY_RE.test(p.key)) add(at, 'key must be dotted lower_snake');
    if (p.pid < 0 || p.pid > 0xffff) add(at, 'pid must fit in u16');
    if (p.pid < MODEL_PID_MIN && !isCommonParam(p)) add(at, 'model parameters must use pid >= 0x0100');
    if (!VALID_PTYPES.has(p.ptype)) add(at, `invalid ptype ${p.ptype}`);
    if (!groups.has(p.group)) add(at, `unknown group '${p.group}'`);
    if (!textOk(p.label)) add(at, 'label needs tr and en');
    if (!textOk(p.help)) add(at, 'help needs tr and en');
    if (!(p.min <= p.max)) add(at, 'min > max');
    if (!(p.step > 0)) add(at, 'step must be > 0');
    if (p.ptype === PType.U32 && p.min < 0) add(at, 'u32 min must be >= 0');
    if (p.ptype === PType.U32 && p.max > 0xffffffff) add(at, 'u32 max exceeds 32 bits');
    if (p.ptype === PType.I32 && (p.min < -0x80000000 || p.max > 0x7fffffff)) add(at, 'i32 range exceeds 32 bits');
    if (p.ptype === PType.BOOL && (p.min !== 0 || p.max !== 1)) add(at, 'bool range must be 0..1');
    if (p.ptype === PType.ENUM) {
      if (!p.options || p.options.length === 0) add(at, 'enum needs options');
      const seen = new Set<number>();
      for (const o of p.options ?? []) {
        if (seen.has(o.value)) add(at, `duplicate option ${o.value}`);
        seen.add(o.value);
        if (!textOk(o.label)) add(at, `option ${o.value} label needs tr and en`);
        if (!Number.isInteger(o.value) || o.value < 0) add(at, `option ${o.value} must be a non-negative integer`);
      }
    } else if (p.options) add(at, 'only enum parameters take options');
    const chk = checkParamValue(p, p.default, { allowReadOnly: true });
    if (chk !== 'ok') add(at, `default ${p.default} invalid (${chk})`);
    if (p.minNonZero !== undefined && !(p.minNonZero > 0 && p.minNonZero <= p.max)) add(at, 'minNonZero outside range');
  }

  // Common parameters must match PROTOCOL §5.
  for (const [pid, key] of [
    [CommonPid.CAN_DATA_BITRATE, 'can.data_bitrate'],
    [CommonPid.CAN_TERMINATION, 'can.termination'],
  ] as const) {
    const p = def.params.find((x) => x.pid === pid);
    if (!p || p.key !== key) add(`params.${key}`, 'missing common parameter');
  }
  const hasCtrl = def.params.some((p) => p.key === 'ctrl.timeout_ms');
  if (hasCtrl && def.params.find((p) => p.key === 'ctrl.timeout_ms')?.pid !== CommonPid.CTRL_TIMEOUT_MS) {
    add('params.ctrl.timeout_ms', 'ctrl.timeout_ms must use pid 0x0003');
  }

  // Signals
  const sids = new Set<number>();
  const skeys = new Set<string>();
  for (const s of def.signals) {
    const at = `signals.${s.key}`;
    if (sids.has(s.sid)) add(at, `duplicate sid ${s.sid}`);
    sids.add(s.sid);
    if (skeys.has(s.key)) add(at, 'duplicate key');
    skeys.add(s.key);
    if (!KEY_RE.test(s.key)) add(at, 'key must be dotted lower_snake');
    if (s.sid < 1 || s.sid >= STREAM_SID_CLEAR) add(at, 'sid must be 1..0xFFFE');
    if (!textOk(s.label)) add(at, 'label needs tr and en');
    if (!(s.range[0] < s.range[1])) add(at, 'display range must be increasing');
    if (!Number.isInteger(s.digits) || s.digits < 0) add(at, 'digits must be a non-negative integer');
    for (const o of s.options ?? []) if (!textOk(o.label)) add(at, `option ${o.value} label needs tr and en`);
    for (const [i, b] of (s.bits ?? []).entries()) if (!textOk(b)) add(at, `bit ${i} label needs tr and en`);
  }

  // Status frames
  const frames = new Set<number>();
  for (const f of def.statusFrames) {
    const at = `statusFrames.${f.index}`;
    if (frames.has(f.index)) add(at, 'duplicate frame index');
    frames.add(f.index);
    if (f.index < 0 || f.index > 15) add(at, 'frame index must be 0..15');
    if (!textOk(f.label)) add(at, 'label needs tr and en');
    const period = def.params.find((p) => p.pid === statusPeriodPid(f.index));
    if (!period || period.key !== statusPeriodKey(f.index)) add(at, 'missing status period parameter');
    const used = new Array<string | null>(STATUS_FRAME_BYTES * 8).fill(null);
    for (const fd of f.fields) {
      const fat = `${at}.${fd.signal}`;
      if (!skeys.has(fd.signal)) add(fat, 'unknown signal');
      const size = FIELD_SIZE[fd.type];
      if (size === undefined) {
        add(fat, `unknown field type ${String(fd.type)}`);
        continue;
      }
      if (fd.byte < 0 || fd.byte + size > STATUS_FRAME_BYTES) add(fat, 'field exceeds 8 bytes');
      if (fd.scale !== undefined && !(fd.scale !== 0 && Number.isFinite(fd.scale))) add(fat, 'scale must be finite and non-zero');
      let start = fd.byte * 8;
      let width = size * 8;
      if (fd.bits !== undefined || fd.bit !== undefined) {
        if (fd.type === 'f32' || fd.type.startsWith('i')) add(fat, 'bit fields need an unsigned container');
        const bit = fd.bit ?? 0;
        const bits = fd.bits ?? 0;
        if (bits < 1 || bit < 0 || bit + bits > size * 8) add(fat, 'bit field outside its container');
        start += bit;
        width = bits;
      }
      for (let b = start; b < start + width && b < used.length; b++) {
        if (b < 0) continue;
        if (used[b] !== null) {
          add(fat, `overlaps ${used[b]}`);
          break;
        }
        used[b] = fd.signal;
      }
    }
  }
  for (const p of def.params) {
    const m = /^status\.(\d+)\.period_ms$/.exec(p.key);
    if (m && !frames.has(Number(m[1]))) add(`params.${p.key}`, 'period parameter without a status frame');
  }

  // Controls
  const ctrlIdx = new Set<number>();
  for (const c of def.controls) {
    const at = `controls.${c.key}`;
    if (ctrlIdx.has(c.index)) add(at, 'duplicate CTRL index');
    ctrlIdx.add(c.index);
    if (c.index < 0 || c.index > 15) add(at, 'CTRL index must be 0..15');
    if (!textOk(c.label)) add(at, 'label needs tr and en');
    if (c.format === 'set') {
      if (!c.modes || c.modes.length === 0) add(at, "'set' control needs modes");
      const mv = new Set<number>();
      for (const m of c.modes ?? []) {
        if (mv.has(m.value)) add(at, `duplicate mode ${m.value}`);
        mv.add(m.value);
        if (m.value < 0 || m.value > 255) add(at, `mode ${m.value} must fit in u8`);
        if (!textOk(m.label)) add(at, `mode ${m.key} label needs tr and en`);
        if (!(m.min <= m.max)) add(at, `mode ${m.key} min > max`);
        if (m.measured !== undefined && !skeys.has(m.measured)) add(at, `mode ${m.key} measures unknown signal`);
      }
    } else if (c.format === 'servo4') {
      if (c.firstChannel === undefined || c.firstChannel < 1) add(at, "'servo4' control needs firstChannel");
    }
  }
  if (def.controls.some((c) => c.format !== 'text') && !hasCtrl) add('params', 'actuator controls need ctrl.timeout_ms');

  // Actions, faults, self-test bits
  const cmds = new Set<number>();
  const akeys = new Set<string>();
  for (const a of def.actions) {
    const at = `actions.${a.key}`;
    if (cmds.has(a.cmd)) add(at, 'duplicate cmd');
    cmds.add(a.cmd);
    if (akeys.has(a.key)) add(at, 'duplicate key');
    akeys.add(a.key);
    if (a.cmd < MODEL_COMMAND_MIN || a.cmd > 0xff) add(at, 'model commands must be 0x40..0xFF');
    if (!textOk(a.label) || !textOk(a.help)) add(at, 'label and help need tr and en');
    if (a.arg && !(a.arg.min <= a.arg.default && a.arg.default <= a.arg.max)) add(at, 'argument default outside range');
  }
  checkBits(def.faults, MODEL_FAULT_BIT_MIN, MODEL_FAULT_BIT_MAX, 'faults', add);
  checkBits(def.selfTestBits, 0, 31, 'selfTestBits', add);

  if (!(def.stream.minPeriodUs >= 100 && def.stream.minPeriodUs % 100 === 0)) {
    add('stream.minPeriodUs', 'must be a positive multiple of 100 µs');
  }

  // Tuner loops
  const lkeys = new Set<string>();
  for (const l of def.tuner.loops) {
    const at = `tuner.${l.key}`;
    if (lkeys.has(l.key)) add(at, 'duplicate loop');
    lkeys.add(l.key);
    if (!textOk(l.label)) add(at, 'label needs tr and en');
    const ctrl = def.controls.find((c) => c.index === l.ctrlFrame);
    if (!ctrl) add(at, `unknown CTRL frame ${l.ctrlFrame}`);
    else if (!ctrl.modes?.some((m) => m.value === l.mode)) add(at, `CTRL frame has no mode ${l.mode}`);
    for (const [role, key] of Object.entries(l.gains)) {
      if (key !== undefined && !pkeys.has(key)) add(at, `gain ${role} refers to unknown parameter '${key}'`);
    }
    if (!l.gains.kp) add(at, 'loop needs at least kp');
    for (const key of l.extraParams ?? []) if (!pkeys.has(key)) add(at, `unknown extra parameter '${key}'`);
    for (const [role, key] of Object.entries(l.signals)) {
      if (!skeys.has(key)) add(at, `signal ${role} refers to unknown signal '${key}'`);
    }
  }
  return issues;
}

function isCommonParam(p: ParamDef): boolean {
  return (
    p.pid === CommonPid.CAN_DATA_BITRATE ||
    p.pid === CommonPid.CAN_TERMINATION ||
    p.pid === CommonPid.CTRL_TIMEOUT_MS ||
    (p.pid >= CommonPid.STATUS_PERIOD_BASE && p.pid < CommonPid.STATUS_PERIOD_BASE + 16)
  );
}

function checkBits(list: BitDef[], lo: number, hi: number, path: string, add: (p: string, m: string) => void): void {
  const bits = new Set<number>();
  const keys = new Set<string>();
  for (const b of list) {
    const at = `${path}.${b.key}`;
    if (bits.has(b.bit)) add(at, `duplicate bit ${b.bit}`);
    bits.add(b.bit);
    if (keys.has(b.key)) add(at, 'duplicate key');
    keys.add(b.key);
    if (b.bit < lo || b.bit > hi) add(at, `bit must be ${lo}..${hi}`);
    if (!textOk(b.label)) add(at, 'label needs tr and en');
  }
}

/** Validates every model plus catalog-wide uniqueness (model code, key). */
export function validateCatalog(models: readonly ModelDef[] = CATALOG): CatalogIssue[] {
  const issues: CatalogIssue[] = [];
  const codes = new Set<number>();
  const keys = new Set<string>();
  for (const m of models) {
    if (codes.has(m.model)) issues.push({ model: m.key, path: 'model', message: `duplicate model code ${m.model}` });
    codes.add(m.model);
    if (keys.has(m.key)) issues.push({ model: m.key, path: 'key', message: 'duplicate model key' });
    keys.add(m.key);
    issues.push(...validateModel(m));
  }
  return issues;
}
