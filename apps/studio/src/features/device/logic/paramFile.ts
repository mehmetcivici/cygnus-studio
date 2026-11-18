import { checkParamValue, quantizeParamValue, type ModelDef, type ParamCheck, type ParamDef } from '@cygnus/protocol';

export const PARAM_FILE_FORMAT = 'cygnus-params';
export const PARAM_FILE_VERSION = 1;
export const PARAM_FILE_EXT = '.cyparams.json';

/**
 * Settings of one board. Identity (number, name, UID) is recorded for the reader only and
 * never applied: the file moves configuration, not identity.
 */
export interface ParamFile {
  format: typeof PARAM_FILE_FORMAT;
  version: typeof PARAM_FILE_VERSION;
  model: number;
  modelKey: string;
  catalogRev: number;
  exportedAt: string;
  source: { uid48: string; num: number; name: string; fw: string | null };
  params: Record<string, number>;
}

export interface ParamFileSource {
  uid48: string;
  num: number;
  name: string;
  fw: string | null;
}

/** Writable catalog parameters only: read-only values describe the board, not its settings. */
export function buildParamFile(def: ModelDef, src: ParamFileSource, values: Readonly<Record<string, number>>, now = new Date()): ParamFile {
  const params: Record<string, number> = {};
  for (const p of def.params) {
    const v = values[p.key];
    if (!p.readOnly && v !== undefined && Number.isFinite(v)) params[p.key] = v;
  }
  return {
    format: PARAM_FILE_FORMAT,
    version: PARAM_FILE_VERSION,
    model: def.model,
    modelKey: def.key,
    catalogRev: def.catalogRev,
    exportedAt: now.toISOString(),
    source: { ...src },
    params,
  };
}

export function serializeParamFile(f: ParamFile): string {
  return `${JSON.stringify(f, null, 2)}\n`;
}

export type ParamFileError = 'json' | 'format' | 'newerVersion' | 'shape' | 'wrongModel';

export type ParseResult = { ok: true; file: ParamFile } | { ok: false; error: ParamFileError; fileModelKey?: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Parses and checks a settings file against the board's model. */
export function parseParamFile(text: string, def: ModelDef): ParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: 'json' };
  }
  if (!isRecord(raw) || raw.format !== PARAM_FILE_FORMAT) return { ok: false, error: 'format' };
  if (typeof raw.version !== 'number') return { ok: false, error: 'shape' };
  if (raw.version > PARAM_FILE_VERSION) return { ok: false, error: 'newerVersion' };
  const { model, modelKey, params, source } = raw;
  if (typeof model !== 'number' || typeof modelKey !== 'string' || !isRecord(params)) return { ok: false, error: 'shape' };
  const values: Record<string, number> = {};
  for (const [k, v] of Object.entries(params)) {
    if (typeof v !== 'number' || !Number.isFinite(v)) return { ok: false, error: 'shape' };
    values[k] = v;
  }
  if (modelKey !== def.key) return { ok: false, error: 'wrongModel', fileModelKey: modelKey };
  const src = isRecord(source) ? source : {};
  return {
    ok: true,
    file: {
      format: PARAM_FILE_FORMAT,
      version: PARAM_FILE_VERSION,
      model,
      modelKey,
      catalogRev: typeof raw.catalogRev === 'number' ? raw.catalogRev : 0,
      exportedAt: typeof raw.exportedAt === 'string' ? raw.exportedAt : '',
      source: {
        uid48: typeof src.uid48 === 'string' ? src.uid48 : '',
        num: typeof src.num === 'number' ? src.num : 0,
        name: typeof src.name === 'string' ? src.name : '',
        fw: typeof src.fw === 'string' ? src.fw : null,
      },
      params: values,
    },
  };
}

/** `change`: will be written · `same`: equal already · `unknown`: not in our catalog · `invalid`: fails catalog limits · `readOnly`. */
export type DiffStatus = 'change' | 'same' | 'unknown' | 'invalid' | 'readOnly';

export interface DiffRow {
  key: string;
  def: ParamDef | undefined;
  /** Value on the board (undefined when not read). */
  from: number | undefined;
  to: number;
  status: DiffStatus;
  check?: ParamCheck;
}

/** Values compare as the board would store them (f32 / integer rounding), so a round trip is "same". */
export function sameParamValue(def: ParamDef | undefined, a: number | undefined, b: number): boolean {
  if (a === undefined) return false;
  if (!def) return a === b;
  return quantizeParamValue(def, a) === quantizeParamValue(def, b);
}

/**
 * Compares incoming values with the board's. Rows follow the catalog order, unknown keys last.
 * `skip` keys (identity-like settings) are left out entirely.
 */
export function diffParams(
  def: ModelDef,
  current: Readonly<Record<string, number>>,
  incoming: Readonly<Record<string, number>>,
  skip: readonly string[] = [],
): DiffRow[] {
  const rows: DiffRow[] = [];
  for (const p of def.params) {
    const to = incoming[p.key];
    if (to === undefined || skip.includes(p.key)) continue;
    const from = current[p.key];
    if (p.readOnly) {
      rows.push({ key: p.key, def: p, from, to, status: 'readOnly' });
      continue;
    }
    const check = checkParamValue(p, to);
    if (check !== 'ok') rows.push({ key: p.key, def: p, from, to, status: 'invalid', check });
    else rows.push({ key: p.key, def: p, from, to, status: sameParamValue(p, from, to) ? 'same' : 'change' });
  }
  for (const [key, to] of Object.entries(incoming)) {
    if (!def.params.some((p) => p.key === key) && !skip.includes(key)) rows.push({ key, def: undefined, from: undefined, to, status: 'unknown' });
  }
  return rows;
}

/** Keys that will be written: changed rows, in order (parameter limits can depend on order). */
export function changedKeys(rows: readonly DiffRow[]): string[] {
  return rows.filter((r) => r.status === 'change').map((r) => r.key);
}

/** Selected changed rows that need a reboot to take effect. */
export function needsReboot(rows: readonly DiffRow[], selected: ReadonlySet<string>): boolean {
  return rows.some((r) => r.status === 'change' && selected.has(r.key) && r.def?.rebootRequired === true);
}
