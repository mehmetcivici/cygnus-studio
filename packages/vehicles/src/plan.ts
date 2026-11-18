import { CATALOG, NAME_BYTES, NUM_MAX, NUM_MIN, paramByKey } from '@cygnus/protocol';
import type { LocalizedText, SlotBinding, VehicleConfig, VehicleSlot, VehicleTemplate } from './types';

export interface PlanDevice {
  uid48: string;
  model: string;
  devType: number;
  num: number;
  name: string;
  /** Known current parameter values by catalog key (channel params as `ch.N.key`); equal values yield no step. */
  params?: Record<string, number>;
  /**
   * False for a board that is lost (or not usable): it cannot be bound, but its number stays
   * reserved so it does not collide when it comes back. Default true.
   */
  online?: boolean;
}

export type PlanStep =
  | { kind: 'assignNum'; uid48: string; slotId: string; devType: number; from: number; to: number }
  | { kind: 'rename'; uid48: string; slotId: string; from: string; to: string }
  | { kind: 'setParam'; uid48: string; slotId: string; key: string; value: number; channel?: number };

export interface PlanWarning { code: 'deviceNotFound' | 'numShifted' | 'numExhausted' | 'nameShortened' | 'modelMismatch' | 'noRemoteEncoder'; slotId?: string; uid48?: string; message: LocalizedText }

export interface PlanResult { steps: PlanStep[]; warnings: PlanWarning[] }

type BoundSlot = { slot: VehicleSlot; binding: Exclude<SlotBinding, { kind: 'external' }> };
interface Card { uid: string; device: PlanDevice; slots: BoundSlot[] }

const norm = (uid: string): string => uid.toLowerCase();
const modelDef = (key: string) => CATALOG.find((m) => m.key === key);

function utf8Len(cp: number): number {
  return cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
}

/** Cuts at code point boundaries so a multi-byte character is never split. */
export function fitName(name: string, maxBytes: number = NAME_BYTES): string {
  let bytes = 0;
  let out = '';
  for (const ch of name) {
    const n = utf8Len(ch.codePointAt(0) ?? 0);
    if (bytes + n > maxBytes) break;
    bytes += n;
    out += ch;
  }
  return out.replace(/[\s·\-–]+$/u, '');
}

const SERVO_NAME: LocalizedText = { tr: 'Servo kartı', en: 'Servo board' };

function firstFree(desired: number, used: Set<number>): number | undefined {
  for (let i = 0; i < NUM_MAX; i++) {
    const n = ((desired - NUM_MIN + i) % NUM_MAX) + NUM_MIN;
    if (!used.has(n)) return n;
  }
  return undefined;
}

/** PWM ESC / servo channel parameters; the board has no ESC presets, so role defaults are derived here. */
function channelParams(slot: VehicleSlot, ch: number): [string, number][] {
  const k = (f: string) => `ch.${ch}.${f}`;
  const out: [string, number][] = [[k('enable'), 1]];
  if (slot.role === 'thruster') out.push([k('min_us'), 1100], [k('center_us'), 1500], [k('max_us'), 1900], [k('failsafe_us'), 1500]);
  else if (slot.role === 'propeller') out.push([k('min_us'), 1000], [k('center_us'), 1500], [k('max_us'), 2000], [k('failsafe_us'), 1000]);
  else if (slot.role === 'surface') out.push([k('failsafe_us'), 1500]);
  if (slot.presets?.['motor.invert'] !== undefined) out.push([k('invert'), slot.presets['motor.invert']]);
  return out;
}

export function planApply(tpl: VehicleTemplate, cfg: VehicleConfig, devices: readonly PlanDevice[], lang: 'tr' | 'en' = 'tr'): PlanResult {
  const warnings: PlanWarning[] = [];
  const steps: PlanStep[] = [];
  const warn = (code: PlanWarning['code'], message: LocalizedText, slotId?: string, uid48?: string): void => {
    warnings.push({ code, message, ...(slotId !== undefined ? { slotId } : {}), ...(uid48 !== undefined ? { uid48 } : {}) });
  };

  const byUid = new Map(devices.map((d) => [norm(d.uid48), d]));
  const cards = new Map<string, Card>();
  for (const slot of tpl.slots) {
    const b = cfg.bindings[slot.id];
    if (!b || b.kind === 'external') continue;
    const uid = norm(b.uid48);
    const found = byUid.get(uid);
    const device = found?.online === false ? undefined : found;
    if (!device) { warn('deviceNotFound', { tr: `Kart hatta yok: ${slot.label.tr}.`, en: `Board not on the bus: ${slot.label.en}.` }, slot.id, b.uid48); continue; }
    if (device.model !== b.model) warn('modelMismatch', { tr: `Hattaki kart "${device.model}", atama "${b.model}".`, en: `Bus board is "${device.model}", binding says "${b.model}".` }, slot.id, b.uid48);
    const card = cards.get(uid) ?? { uid, device, slots: [] };
    card.slots.push({ slot, binding: b });
    cards.set(uid, card);
  }

  // Numbers: boards outside the plan keep theirs; planned boards are placed one by one so none end up equal.
  const used = new Map<number, Set<number>>();
  const usedFor = (devType: number): Set<number> => {
    let s = used.get(devType);
    if (!s) { s = new Set(); used.set(devType, s); }
    return s;
  };
  for (const d of devices) if (!cards.has(norm(d.uid48)) && d.num >= NUM_MIN && d.num <= NUM_MAX) usedFor(d.devType).add(d.num);

  const finalNum = new Map<string, number>();
  const numSteps: PlanStep[] = [];
  for (const card of cards.values()) {
    const set = usedFor(card.device.devType);
    const first = card.slots[0]?.slot;
    const desired = card.slots.map((s) => s.slot.suggestedNum).find((n) => n !== undefined);
    const current = card.device.num;
    const currentOk = current >= NUM_MIN && current <= NUM_MAX && !set.has(current);
    let target: number | undefined;
    if (desired === undefined) target = currentOk ? current : firstFree(NUM_MIN, set);
    else if (!set.has(desired)) target = desired;
    else {
      target = firstFree(desired, set);
      if (target !== undefined) warn('numShifted', { tr: `Numara ${desired} dolu; ${target} atandı.`, en: `Number ${desired} is taken; assigned ${target}.` }, first?.id, card.device.uid48);
    }
    if (target === undefined) {
      warn('numExhausted', { tr: 'Boş numara kalmadı.', en: 'No free number left.' }, first?.id, card.device.uid48);
      // Without a number the board answers nothing but discovery: plan nothing else for it.
      cards.delete(card.uid);
      continue;
    }
    set.add(target);
    finalNum.set(card.uid, target);
    if (target !== current && first) numSteps.push({ kind: 'assignNum', uid48: card.device.uid48, slotId: first.id, devType: card.device.devType, from: current, to: target });
  }
  steps.push(...numSteps);

  for (const card of cards.values()) {
    const first = card.slots[0]?.slot;
    if (!first) continue;
    const label = card.slots.length === 1 ? first.label[lang] : SERVO_NAME[lang];
    const name = fitName(label);
    if (name !== label) warn('nameShortened', { tr: `Ad kısaltıldı: ${name}`, en: `Name shortened: ${name}` }, first.id, card.device.uid48);
    if (name !== card.device.name) steps.push({ kind: 'rename', uid48: card.device.uid48, slotId: first.id, from: card.device.name, to: name });
  }

  const pushParam = (card: Card, slotId: string, key: string, value: number, channel?: number): void => {
    if (card.device.params?.[key] === value) return;
    steps.push({ kind: 'setParam', uid48: card.device.uid48, slotId, key, value, ...(channel !== undefined ? { channel } : {}) });
  };

  for (const card of cards.values()) {
    for (const { slot, binding } of card.slots) {
      const def = modelDef(binding.model);
      if (!def) continue;
      if (binding.kind === 'channel') {
        for (const [key, value] of channelParams(slot, binding.channel)) if (paramByKey(def, key)) pushParam(card, slot.id, key, value, binding.channel);
        continue;
      }
      const preset = { ...(slot.presets ?? {}) };
      if (preset['fb.source'] === 2) {
        // Remote feedback needs the number of the encoder of the same module.
        const enc = tpl.slots.find((s) => s.group !== undefined && s.group === slot.group && (s.role === 'steerEncoder' || s.role === 'jointEncoder' || s.role === 'encoder'));
        const eb = enc ? cfg.bindings[enc.id] : undefined;
        const num = eb && eb.kind !== 'external' ? finalNum.get(norm(eb.uid48)) : undefined;
        if (num === undefined) { delete preset['fb.source']; warn('noRemoteEncoder', { tr: 'Uzak encoder atanmamış; geri besleme ayarı atlandı.', en: 'No remote encoder assigned; feedback setting skipped.' }, slot.id, card.device.uid48); }
        else preset['fb.remote_num'] = num;
      }
      for (const [key, value] of Object.entries(preset)) if (paramByKey(def, key)) pushParam(card, slot.id, key, value);
    }
  }
  return { steps, warnings };
}
