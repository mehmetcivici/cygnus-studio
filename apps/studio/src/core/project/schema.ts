import type { DeviceHandle } from '@cygnus/protocol';
import type { SlotBinding, VehicleConfig } from '@cygnus/vehicles';

export const PROJECT_FORMAT = 'cygnus-project';
export const PROJECT_VERSION = 1;
export const PROJECT_EXT = '.cygnus.json';

/** One board as captured from the bus. */
export interface ProjectDevice {
  uid48: string;
  driver: string;
  model: number;
  /** Catalog model key (`esc80a`), so files stay readable without the catalog. */
  modelKey: string;
  devType: number;
  num: number;
  name: string;
  fw: string | null;
  /** Catalog key → value, as read from the board. */
  params: Record<string, number>;
}

export interface ProjectFile {
  format: typeof PROJECT_FORMAT;
  version: typeof PROJECT_VERSION;
  name: string;
  createdAt: string;
  modifiedAt: string;
  appVersion: string;
  bus: { capturedAt: string | null; devices: ProjectDevice[] };
  vehicle: VehicleConfig | null;
  notes: string;
  /**
   * Feature-owned data (tuner runs, plot layouts …) keyed by section id. Unknown sections are
   * preserved on load/save so older builds never drop a newer screen's data.
   */
  sections: Record<string, unknown>;
  /**
   * Schema version of each section's data (absent = 1). Kept beside `sections` so section values
   * stay plain data; `defineProjectSection` migrates older versions on read.
   */
  sectionVersions?: Record<string, number>;
}

export function emptyProject(name: string, appVersion: string, now = new Date()): ProjectFile {
  const iso = now.toISOString();
  return {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    name,
    createdAt: iso,
    modifiedAt: iso,
    appVersion,
    bus: { capturedAt: null, devices: [] },
    vehicle: null,
    notes: '',
    sections: {},
  };
}

export function projectDeviceFrom(h: DeviceHandle, params: Record<string, number>): ProjectDevice {
  return {
    uid48: h.uid48,
    driver: h.driver,
    model: h.model,
    modelKey: h.def?.key ?? `model${h.model}`,
    devType: h.devType,
    num: h.num,
    name: h.name,
    fw: h.fw ? `${h.fw.major}.${h.fw.minor}.${h.fw.patch}` : null,
    params,
  };
}

/** Pretty-printed with a trailing newline (diff-friendly in git). */
export function serializeProject(p: ProjectFile): string {
  return JSON.stringify(p, null, 2) + '\n';
}

export type ProjectParseError = 'json' | 'format' | 'newerVersion' | 'shape';
/** Parts of an otherwise valid file that were dropped while loading (shown to the user). */
export interface ProjectParseWarning {
  path: string;
  detail: string;
}
export type ProjectParseResult =
  | { ok: true; project: ProjectFile; warnings: ProjectParseWarning[] }
  | { ok: false; error: ProjectParseError; detail?: string };

/** 48-bit board id as 12 lowercase hex digits. */
export const UID48_RE = /^[0-9a-f]{12}$/;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d);
const num = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);

const normUid = (v: unknown): string | null => {
  if (typeof v !== 'string') return null;
  const u = v.toLowerCase();
  return UID48_RE.test(u) ? u : null;
};

function parseDevice(v: unknown): ProjectDevice | null {
  if (!isObj(v) || typeof v.model !== 'number' || !Number.isInteger(v.model)) return null;
  const uid48 = normUid(v.uid48);
  if (!uid48) return null;
  const params: Record<string, number> = {};
  if (isObj(v.params)) for (const [k, x] of Object.entries(v.params)) if (typeof x === 'number' && Number.isFinite(x)) params[k] = x;
  return {
    uid48,
    driver: str(v.driver, 'cycan'),
    model: v.model,
    modelKey: str(v.modelKey),
    devType: num(v.devType),
    num: num(v.num),
    name: str(v.name),
    fw: typeof v.fw === 'string' ? v.fw : null,
    params,
  };
}

/** Shape check of one slot binding; template-level checks happen in @cygnus/vehicles. */
export function parseBinding(v: unknown): SlotBinding | null {
  if (!isObj(v)) return null;
  if (v.kind === 'external') {
    const canId = v.canId;
    if (canId !== undefined && !(typeof canId === 'number' && Number.isInteger(canId) && canId >= 0 && canId <= 0x1fffffff)) return null;
    return canId === undefined ? { kind: 'external', note: str(v.note) } : { kind: 'external', canId, note: str(v.note) };
  }
  const uid48 = normUid(v.uid48);
  if (!uid48 || typeof v.model !== 'string') return null;
  if (v.kind === 'device') return { kind: 'device', uid48, model: v.model };
  if (v.kind === 'channel' && typeof v.channel === 'number' && Number.isInteger(v.channel) && v.channel >= 0 && v.channel < 256) {
    return { kind: 'channel', uid48, model: v.model, channel: v.channel };
  }
  return null;
}

function parseVehicle(v: unknown, warnings: ProjectParseWarning[]): VehicleConfig | null {
  if (v === null || v === undefined) return null;
  if (!isObj(v) || typeof v.templateId !== 'string' || !isObj(v.bindings)) {
    warnings.push({ path: 'vehicle', detail: 'shape' });
    return null;
  }
  const bindings: Record<string, SlotBinding> = {};
  for (const [slot, raw] of Object.entries(v.bindings)) {
    const b = parseBinding(raw);
    if (b) bindings[slot] = b;
    else warnings.push({ path: `vehicle.bindings.${slot}`, detail: 'binding' });
  }
  return { templateId: v.templateId, name: str(v.name), bindings };
}

function parseSectionVersions(v: unknown): Record<string, number> | undefined {
  if (!isObj(v)) return undefined;
  const out: Record<string, number> = {};
  for (const [k, x] of Object.entries(v)) if (typeof x === 'number' && Number.isInteger(x) && x >= 1) out[k] = x;
  return Object.keys(out).length ? out : undefined;
}

/** Accepts text or an already parsed value. Older versions would be migrated here. */
export function parseProject(input: string | unknown): ProjectParseResult {
  let v: unknown = input;
  if (typeof input === 'string') {
    try {
      v = JSON.parse(input);
    } catch (e) {
      return { ok: false, error: 'json', detail: e instanceof Error ? e.message : String(e) };
    }
  }
  if (!isObj(v) || v.format !== PROJECT_FORMAT) return { ok: false, error: 'format' };
  if (typeof v.version !== 'number' || !Number.isInteger(v.version) || v.version < 1) return { ok: false, error: 'shape', detail: 'version' };
  if (v.version > PROJECT_VERSION) return { ok: false, error: 'newerVersion', detail: String(v.version) };
  const bus = isObj(v.bus) ? v.bus : {};
  const devices = Array.isArray(bus.devices) ? bus.devices.map(parseDevice) : [];
  if (devices.some((d) => d === null)) return { ok: false, error: 'shape', detail: 'bus.devices' };
  const now = new Date().toISOString();
  const warnings: ProjectParseWarning[] = [];
  const vehicle = parseVehicle(v.vehicle, warnings);
  const sectionVersions = parseSectionVersions(v.sectionVersions);
  return {
    ok: true,
    warnings,
    project: {
      format: PROJECT_FORMAT,
      version: PROJECT_VERSION,
      name: str(v.name),
      createdAt: str(v.createdAt, now),
      modifiedAt: str(v.modifiedAt, now),
      appVersion: str(v.appVersion),
      bus: { capturedAt: typeof bus.capturedAt === 'string' ? bus.capturedAt : null, devices: devices as ProjectDevice[] },
      vehicle,
      notes: str(v.notes),
      sections: isObj(v.sections) ? { ...v.sections } : {},
      ...(sectionVersions ? { sectionVersions } : {}),
    },
  };
}
