import { CATALOG, NUM_MAX, NUM_MIN } from '@cygnus/protocol';
import {
  getTemplate,
  validateConfig,
  type ConfigIssue,
  type LocalizedText,
  type PlanResult,
  type PlanStep,
  type SlotAccept,
  type SlotBinding,
  type SlotRole,
  type VehicleConfig,
  type VehicleSlot,
  type VehicleTemplate,
} from '@cygnus/vehicles';

// ---------- roles ----------

export const ACTUATOR_ROLES: ReadonlySet<SlotRole> = new Set<SlotRole>(['drive', 'steer', 'thruster', 'propeller', 'joint', 'pan', 'tilt', 'surface', 'gripper', 'aux']);
export const ENCODER_ROLES: ReadonlySet<SlotRole> = new Set<SlotRole>(['steerEncoder', 'jointEncoder', 'encoder']);
export const ALL_ROLES: readonly SlotRole[] = [
  'drive', 'steer', 'thruster', 'propeller', 'joint', 'pan', 'tilt', 'surface', 'gripper', 'aux',
  'steerEncoder', 'jointEncoder', 'encoder', 'gyro', 'power', 'computePower', 'display',
];

export const isActuator = (s: Pick<VehicleSlot, 'role'>): boolean => ACTUATOR_ROLES.has(s.role);
export const isEncoder = (s: Pick<VehicleSlot, 'role'>): boolean => ENCODER_ROLES.has(s.role);

/** What a user-made slot of each role accepts (same rules as the built-in templates). */
export function defaultAccepts(role: SlotRole): SlotAccept[] {
  const dev = (...m: string[]): SlotAccept[] => m.map((model) => ({ model, via: 'device' }));
  const ch: SlotAccept = { model: 'servo16', via: 'channel' };
  switch (role) {
    case 'drive':
    case 'steer':
      return dev('esc20a', 'esc80a');
    case 'thruster':
    case 'propeller':
      return [...dev('esc20a', 'esc80a'), ch];
    case 'joint':
    case 'surface':
    case 'gripper':
      return [...dev('sealed_servo'), ch];
    case 'pan':
    case 'tilt':
    case 'aux':
      return [...dev('esc20a', 'esc80a', 'sealed_servo'), ch];
    case 'steerEncoder':
    case 'jointEncoder':
    case 'encoder':
      return dev('cyncoder');
    case 'gyro':
      return dev('gyro');
    case 'power':
      return dev('pdh_small', 'pdh_large');
    case 'computePower':
      return dev('soc_reg');
    case 'display':
      return dev('oled');
  }
}

// ---------- devices as the vehicle logic sees them ----------

export interface DeviceLite {
  uid48: string;
  online: boolean;
  /** Catalog model key; undefined for unknown models. */
  model: string | undefined;
  devType: number;
  num: number;
  name: string;
  unassigned: boolean;
  conflict: boolean;
}

export const normUid = (uid: string): string => uid.toLowerCase();

export function sameDevice(b: SlotBinding | undefined, uid48: string): boolean {
  return !!b && b.kind !== 'external' && normUid(b.uid48) === normUid(uid48);
}

// ---------- slot status ----------

export type SlotStatus = 'empty' | 'online' | 'lost' | 'external' | 'incompatible';

const CONFLICT_CODES = new Set<ConfigIssue['code']>(['duplicateDevice', 'duplicateChannel', 'modelMismatch', 'invalidChannel', 'externalNotAllowed']);

export function slotStatuses(tpl: VehicleTemplate, bindings: Readonly<Record<string, SlotBinding>>, devices: readonly DeviceLite[]): Record<string, SlotStatus> {
  const byUid = new Map(devices.map((d) => [normUid(d.uid48), d]));
  const issues = validateConfig(tpl, { templateId: tpl.id, name: '', bindings: { ...bindings } });
  const conflicted = new Set(issues.filter((i) => CONFLICT_CODES.has(i.code) && i.slotId).map((i) => i.slotId));
  const out: Record<string, SlotStatus> = {};
  for (const s of tpl.slots) {
    const b = bindings[s.id];
    if (!b) out[s.id] = 'empty';
    else if (b.kind === 'external') out[s.id] = conflicted.has(s.id) ? 'incompatible' : 'external';
    else {
      const d = byUid.get(normUid(b.uid48));
      if (!d || !d.online) out[s.id] = 'lost';
      else if (conflicted.has(s.id) || (d.model !== undefined && d.model !== b.model)) out[s.id] = 'incompatible';
      else out[s.id] = 'online';
    }
  }
  return out;
}

// ---------- compatible boards ----------

export interface Candidate {
  device: DeviceLite;
  /** How this board fits the selected slot; null when listed without a slot. */
  via: 'device' | 'channel' | null;
  /** Slots it is already bound to (as a whole board or by channel). */
  boundTo: string[];
  /** Unused servo channels (channel candidates only). */
  freeChannels: number[];
}

export const SERVO_CHANNELS = 16;

export function usedChannels(bindings: Readonly<Record<string, SlotBinding>>, uid48: string, exceptSlot?: string): Set<number> {
  const used = new Set<number>();
  for (const [id, b] of Object.entries(bindings)) if (id !== exceptSlot && b.kind === 'channel' && sameDevice(b, uid48)) used.add(b.channel);
  return used;
}

export function freeChannels(bindings: Readonly<Record<string, SlotBinding>>, uid48: string, exceptSlot?: string): number[] {
  const used = usedChannels(bindings, uid48, exceptSlot);
  const out: number[] = [];
  for (let c = 1; c <= SERVO_CHANNELS; c++) if (!used.has(c)) out.push(c);
  return out;
}

function boundSlots(bindings: Readonly<Record<string, SlotBinding>>, uid48: string): string[] {
  return Object.entries(bindings)
    .filter(([, b]) => sameDevice(b, uid48))
    .map(([id]) => id);
}

/**
 * Boards to offer for a slot: online boards whose model the slot accepts (a servo board is
 * offered for its channels). Free boards come first, boards bound elsewhere after them.
 * Without a slot every online board is listed.
 */
export function candidatesFor(slot: VehicleSlot | null, bindings: Readonly<Record<string, SlotBinding>>, devices: readonly DeviceLite[]): Candidate[] {
  const out: Candidate[] = [];
  for (const d of devices) {
    if (!d.online || d.model === undefined) continue;
    const boundTo = boundSlots(bindings, d.uid48);
    if (!slot) {
      out.push({ device: d, via: null, boundTo, freeChannels: d.model === 'servo16' ? freeChannels(bindings, d.uid48) : [] });
      continue;
    }
    const asDevice = slot.accepts.some((a) => a.via === 'device' && a.model === d.model);
    const asChannel = slot.accepts.some((a) => a.via === 'channel' && a.model === d.model);
    if (asDevice) out.push({ device: d, via: 'device', boundTo, freeChannels: [] });
    else if (asChannel) out.push({ device: d, via: 'channel', boundTo, freeChannels: freeChannels(bindings, d.uid48, slot.id) });
  }
  const rank = (c: Candidate): number => {
    if (slot && c.boundTo.includes(slot.id)) return 0;
    if (c.via === 'channel') return c.freeChannels.length > 0 ? 1 : 3;
    return c.boundTo.length === 0 ? 1 : 2;
  };
  return out.sort((a, b) => rank(a) - rank(b) || a.device.devType - b.device.devType || a.device.num - b.device.num || a.device.uid48.localeCompare(b.device.uid48));
}

// ---------- binding edits ----------

/**
 * Puts a binding on a slot. A board can serve only one slot as a whole board, and one servo
 * channel only one slot, so the same board/channel is taken off any other slot (a move).
 */
export function bindSlot(bindings: Readonly<Record<string, SlotBinding>>, slotId: string, binding: SlotBinding): Record<string, SlotBinding> {
  const out: Record<string, SlotBinding> = {};
  for (const [id, b] of Object.entries(bindings)) {
    if (id === slotId) continue;
    if (binding.kind !== 'external' && b.kind !== 'external' && sameDevice(b, binding.uid48)) {
      if (binding.kind === 'device') continue; // whole board moves here
      if (b.kind === 'device') continue; // was a whole board, now used by channel
      if (b.kind === 'channel' && b.channel === binding.channel) continue;
    }
    out[id] = b;
  }
  out[slotId] = binding;
  return out;
}

export function unbindSlot(bindings: Readonly<Record<string, SlotBinding>>, slotId: string): Record<string, SlotBinding> {
  const out = { ...bindings };
  delete out[slotId];
  return out;
}

/** The binding a candidate makes for a slot (first free channel for servo boards). */
export function bindingFor(c: Candidate, channel?: number): SlotBinding | null {
  if (c.device.model === undefined) return null;
  if (c.via === 'channel') {
    const ch = channel ?? c.freeChannels[0];
    return ch === undefined ? null : { kind: 'channel', uid48: c.device.uid48, model: c.device.model, channel: ch };
  }
  return { kind: 'device', uid48: c.device.uid48, model: c.device.model };
}

// ---------- sequential assignment ----------

export interface SeqState {
  active: boolean;
  /** Slot ids in visiting order. */
  order: readonly string[];
  index: number;
  /** Every slot in the order has a binding. */
  done: boolean;
}

export type SeqAction =
  | { type: 'start'; order: readonly string[]; bindings: Readonly<Record<string, SlotBinding>> }
  | { type: 'assigned'; bindings: Readonly<Record<string, SlotBinding>> }
  | { type: 'skip'; bindings: Readonly<Record<string, SlotBinding>> }
  | { type: 'back' }
  | { type: 'stop' };

export const SEQ_IDLE: SeqState = { active: false, order: [], index: -1, done: false };

/** First unbound slot after `from` (wrapping), not counting `from` itself; -1 if none. */
function nextOpen(order: readonly string[], from: number, bindings: Readonly<Record<string, SlotBinding>>, includeFrom: boolean): number {
  const n = order.length;
  for (let k = includeFrom ? 0 : 1; k < n; k++) {
    const i = (((from + k) % n) + n) % n;
    const id = order[i];
    if (id !== undefined && !bindings[id]) return i;
  }
  return -1;
}

export function seqReducer(s: SeqState, a: SeqAction): SeqState {
  switch (a.type) {
    case 'start': {
      if (a.order.length === 0) return { active: true, order: a.order, index: -1, done: true };
      const i = nextOpen(a.order, 0, a.bindings, true);
      return { active: true, order: a.order, index: i, done: i < 0 };
    }
    case 'assigned':
    case 'skip': {
      if (!s.active || s.done) return s;
      const i = nextOpen(s.order, s.index, a.bindings, false);
      if (i >= 0) return { ...s, index: i };
      // Skip with nothing else open stays on the current slot; an assignment finishes the run.
      if (a.type === 'skip') return s;
      return { ...s, index: -1, done: true };
    }
    case 'back': {
      if (!s.active || s.order.length === 0) return s;
      const from = s.index < 0 ? s.order.length : s.index;
      return { ...s, index: Math.max(0, from - 1), done: false };
    }
    case 'stop':
      return SEQ_IDLE;
  }
}

export const seqCurrent = (s: SeqState): string | null => (s.active && !s.done ? (s.order[s.index] ?? null) : null);

/** Visiting order: required slots first, in template order. */
export function seqOrder(tpl: VehicleTemplate): string[] {
  return [...tpl.slots.filter((s) => s.required), ...tpl.slots.filter((s) => !s.required)].map((s) => s.id);
}

// ---------- user-made slots (empty template) ----------

const r2 = (n: number): number => Math.round(Math.max(-1, Math.min(1, n)) * 100) / 100;

export function addCustomSlot(slots: readonly VehicleSlot[], role: SlotRole, label: (n: number) => LocalizedText, pos: { x: number; y: number } = { x: 0, y: 0 }): VehicleSlot[] {
  let n = 1;
  while (slots.some((s) => s.id === `${role}.${n}`)) n++;
  const slot: VehicleSlot = { id: `${role}.${n}`, role, label: label(n), accepts: defaultAccepts(role), required: true, pos: { x: r2(pos.x), y: r2(pos.y) } };
  if (role === 'drive' || role === 'thruster') slot.headingDeg = 0;
  if (role === 'propeller') slot.spin = 'cw';
  return [...slots, slot];
}

export function moveCustomSlot(slots: readonly VehicleSlot[], id: string, pos: { x: number; y: number }): VehicleSlot[] {
  return slots.map((s) => (s.id === id ? { ...s, pos: { x: r2(pos.x), y: r2(pos.y) } } : s));
}

export type CustomSlotPatch = Partial<Pick<VehicleSlot, 'label' | 'required' | 'headingDeg' | 'spin' | 'accepts'>>;

export function updateCustomSlot(slots: readonly VehicleSlot[], id: string, patch: CustomSlotPatch): VehicleSlot[] {
  return slots.map((s) => {
    if (s.id !== id) return s;
    const next: VehicleSlot = { ...s, ...patch };
    if (next.role !== 'propeller') delete next.spin;
    if (patch.accepts && patch.accepts.length === 0) next.accepts = s.accepts;
    return next;
  });
}

export function removeCustomSlot(slots: readonly VehicleSlot[], id: string): VehicleSlot[] {
  return slots.filter((s) => s.id !== id);
}

const devTypeOf = (key: string): number | undefined => CATALOG.find((m) => m.key === key)?.devType;

/** Suggested numbers in slot order, unique per DEVTYPE (the bus address is DEVTYPE + NUM). */
export function fillSuggestedNums(slots: readonly VehicleSlot[]): VehicleSlot[] {
  const used = new Map<number, Set<number>>();
  const usedFor = (t: number): Set<number> => {
    let u = used.get(t);
    if (!u) used.set(t, (u = new Set()));
    return u;
  };
  const types = (s: VehicleSlot): number[] => [...new Set(s.accepts.map((a) => devTypeOf(a.model)).filter((t): t is number => t !== undefined))];
  for (const s of slots) if (s.suggestedNum !== undefined) for (const t of types(s)) usedFor(t).add(s.suggestedNum);
  return slots.map((s) => {
    if (s.suggestedNum !== undefined) return s;
    const ts = types(s);
    let n = NUM_MIN;
    while (n < NUM_MAX && ts.some((t) => usedFor(t).has(n))) n++;
    for (const t of ts) usedFor(t).add(n);
    return { ...s, suggestedNum: n };
  });
}

// ---------- per-slot tweaks and the effective template ----------

export interface SlotTweak {
  invert?: boolean;
  gearRatio?: number;
  num?: number;
}

export type Tweaks = Record<string, SlotTweak>;

/** Catalog key that inverts the direction for what is bound to the slot. */
export function invertKey(b: SlotBinding | undefined): string | null {
  if (!b || b.kind === 'external') return null;
  if (b.kind === 'channel') return 'motor.invert'; // planApply maps it to ch.N.invert
  switch (b.model) {
    case 'esc20a':
    case 'esc80a':
      return 'motor.invert';
    case 'sealed_servo':
      return 'motion.invert';
    case 'cyncoder':
      return 'enc.invert';
    default:
      return null;
  }
}

export const hasGearRatio = (b: SlotBinding | undefined): boolean => !!b && b.kind === 'device' && (b.model === 'esc20a' || b.model === 'esc80a');

export function baseTemplate(templateId: string, customSlots: readonly VehicleSlot[]): VehicleTemplate | undefined {
  const tpl = getTemplate(templateId);
  if (!tpl) return undefined;
  if (tpl.category !== 'custom') return tpl;
  return { ...tpl, slots: fillSuggestedNums(customSlots) };
}

/** The template planApply sees: user slots for the empty template, tweaks folded into presets and numbers. */
export function effectiveTemplate(base: VehicleTemplate, tweaks: Readonly<Tweaks>, bindings: Readonly<Record<string, SlotBinding>>): VehicleTemplate {
  return {
    ...base,
    slots: base.slots.map((s) => {
      const tw = tweaks[s.id];
      if (!tw) return s;
      const b = bindings[s.id];
      const presets: Record<string, number> = { ...(s.presets ?? {}) };
      const ik = invertKey(b);
      if (tw.invert !== undefined && ik) presets[ik] = tw.invert ? 1 : 0;
      if (tw.gearRatio !== undefined && hasGearRatio(b)) presets['motor.gear_ratio'] = tw.gearRatio;
      const out: VehicleSlot = { ...s };
      if (Object.keys(presets).length > 0) out.presets = presets;
      if (tw.num !== undefined) out.suggestedNum = tw.num;
      return out;
    }),
  };
}

export function makeConfig(templateId: string, name: string, bindings: Readonly<Record<string, SlotBinding>>): VehicleConfig {
  return { templateId, name, bindings: { ...bindings } };
}

// ---------- plan presentation ----------

export interface PlanGroup {
  uid48: string;
  slotIds: string[];
  num: PlanStep[];
  name: PlanStep[];
  params: PlanStep[];
}

/** Groups plan steps per board: number, then name, then parameters. */
export function groupPlan(plan: PlanResult, slotOrder?: readonly string[]): PlanGroup[] {
  const groups = new Map<string, PlanGroup>();
  for (const s of plan.steps) {
    const k = normUid(s.uid48);
    let g = groups.get(k);
    if (!g) groups.set(k, (g = { uid48: s.uid48, slotIds: [], num: [], name: [], params: [] }));
    if (!g.slotIds.includes(s.slotId)) g.slotIds.push(s.slotId);
    if (s.kind === 'assignNum') g.num.push(s);
    else if (s.kind === 'rename') g.name.push(s);
    else g.params.push(s);
  }
  const out = [...groups.values()];
  if (!slotOrder) return out;
  // Listed in template order (front left drive, front left steer, …), not in plan order.
  const rank = (id: string): number => {
    const i = slotOrder.indexOf(id);
    return i < 0 ? slotOrder.length : i;
  };
  for (const g of out) g.slotIds.sort((a, b) => rank(a) - rank(b));
  return out.sort((a, b) => rank(a.slotIds[0] ?? '') - rank(b.slotIds[0] ?? ''));
}

/** Slots whose suggested number collides with another slot of the same DEVTYPE. */
export function numberClashes(tpl: VehicleTemplate, bindings: Readonly<Record<string, SlotBinding>>): Set<string> {
  const seen = new Map<string, string>();
  const out = new Set<string>();
  for (const s of tpl.slots) {
    const b = bindings[s.id];
    if (!b || b.kind !== 'device' || s.suggestedNum === undefined) continue;
    const t = devTypeOf(b.model);
    if (t === undefined) continue;
    const k = `${t}:${s.suggestedNum}`;
    const other = seen.get(k);
    if (other && !sameDevice(bindings[other], b.uid48)) {
      out.add(s.id);
      out.add(other);
    } else seen.set(k, s.id);
  }
  return out;
}

/** "8 motors · 4 encoders · gyro" style counts, by role family. */
export function slotCounts(tpl: VehicleTemplate): { actuators: number; sensors: number; infra: number; required: number } {
  let actuators = 0;
  let sensors = 0;
  let infra = 0;
  let required = 0;
  for (const s of tpl.slots) {
    if (isActuator(s)) actuators++;
    else if (isEncoder(s) || s.role === 'gyro') sensors++;
    else infra++;
    if (s.required) required++;
  }
  return { actuators, sensors, infra, required };
}

// ---------- repair of loaded configs ----------

const UID48_RE = /^[0-9a-f]{12}$/;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** One stored binding in its valid shape, or null when it cannot be trusted (hand-edited or corrupt file). */
export function sanitizeBinding(v: unknown): SlotBinding | null {
  if (!isRecord(v)) return null;
  if (v.kind === 'external') {
    const note = typeof v.note === 'string' ? v.note.slice(0, 200) : '';
    const canId = typeof v.canId === 'number' && Number.isInteger(v.canId) && v.canId >= 0 && v.canId <= 0x1fffffff ? v.canId : undefined;
    return canId === undefined ? { kind: 'external', note } : { kind: 'external', canId, note };
  }
  if (v.kind !== 'device' && v.kind !== 'channel') return null;
  if (typeof v.uid48 !== 'string' || typeof v.model !== 'string') return null;
  const uid48 = v.uid48.toLowerCase();
  // An unknown model is kept: slot status shows it as incompatible instead of losing the user's choice.
  if (!UID48_RE.test(uid48) || v.model.length === 0 || v.model.length > 32) return null;
  if (v.kind === 'device') return { kind: 'device', uid48, model: v.model };
  const ch = v.channel;
  if (typeof ch !== 'number' || !Number.isInteger(ch) || ch < 1 || ch > SERVO_CHANNELS) return null;
  return { kind: 'channel', uid48, model: v.model, channel: ch };
}

export interface RepairedConfig {
  config: VehicleConfig;
  /** Slot ids whose binding was dropped (bad shape or unknown slot). */
  dropped: string[];
}

/**
 * A vehicle config read from a project file, made safe to render: every binding is checked
 * against its shape and the template's slot list, and anything unusable is dropped. The
 * same object comes back when nothing had to change, so memoised consumers stay stable.
 */
export function repairVehicleConfig(cfg: VehicleConfig, slotIds?: ReadonlySet<string>): RepairedConfig {
  const raw: unknown = cfg.bindings;
  const src = isRecord(raw) ? raw : {};
  const dropped: string[] = [];
  const bindings: Record<string, SlotBinding> = {};
  let changed = !isRecord(raw);
  for (const [slotId, v] of Object.entries(src)) {
    const b = slotIds && !slotIds.has(slotId) ? null : sanitizeBinding(v);
    if (!b) {
      dropped.push(slotId);
      changed = true;
      continue;
    }
    if (JSON.stringify(b) !== JSON.stringify(v)) changed = true;
    bindings[slotId] = b;
  }
  const name = typeof cfg.name === 'string' ? cfg.name : '';
  if (name !== cfg.name) changed = true;
  return { config: changed ? { templateId: cfg.templateId, name, bindings } : cfg, dropped };
}
