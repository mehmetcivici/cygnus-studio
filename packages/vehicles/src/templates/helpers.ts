import { CATALOG, NUM_MIN } from '@cygnus/protocol';
import type { LocalizedText, SlotAccept, SlotRole, VehicleSlot } from '../types';

export const t = (tr: string, en: string): LocalizedText => ({ tr, en });

const dev = (...models: string[]): SlotAccept[] => models.map((model) => ({ model, via: 'device' as const }));
const chan = (model: string): SlotAccept => ({ model, via: 'channel' });

export const ACCEPT = {
  motor: dev('esc20a', 'esc80a'),
  /** Thrusters and propellers may also be driven as PWM ESCs from a servo board channel. */
  motorOrChannel: [...dev('esc20a', 'esc80a'), chan('servo16')],
  servo: [...dev('sealed_servo'), chan('servo16')],
  motorOrServo: [...dev('esc20a', 'esc80a', 'sealed_servo'), chan('servo16')],
  encoder: dev('cyncoder'),
  gyro: dev('gyro'),
  power: dev('pdh_small', 'pdh_large'),
  soc: dev('soc_reg'),
} as const;

export interface SlotInit {
  id: string;
  role: SlotRole;
  label: LocalizedText;
  accepts: readonly SlotAccept[];
  pos: [number, number];
  required?: boolean;
  group?: string;
  headingDeg?: number;
  spin?: 'cw' | 'ccw';
  suggestedNum?: number;
  presets?: Record<string, number>;
}

export function slot(i: SlotInit): VehicleSlot {
  const s: VehicleSlot = {
    id: i.id,
    role: i.role,
    label: i.label,
    accepts: [...i.accepts],
    required: i.required ?? true,
    pos: { x: i.pos[0], y: i.pos[1] },
  };
  if (i.group !== undefined) s.group = i.group;
  if (i.headingDeg !== undefined) s.headingDeg = i.headingDeg;
  if (i.spin !== undefined) s.spin = i.spin;
  if (i.suggestedNum !== undefined) s.suggestedNum = i.suggestedNum;
  if (i.presets !== undefined) s.presets = { ...i.presets };
  return s;
}

/**
 * Device types a slot can put on the bus as a whole board. Channel-only slots count as their
 * board's type too, so channel slots and boards of that type do not get equal suggestions.
 */
export function slotDevTypes(s: VehicleSlot): number[] {
  const out = new Set<number>();
  for (const a of s.accepts) {
    const d = CATALOG.find((m) => m.key === a.model);
    if (d) out.add(d.devType);
  }
  return [...out];
}

/**
 * Fills missing suggestedNum values in slot order. Numbers are unique per DEVTYPE (the bus
 * address is DEVTYPE + NUM), so e.g. the power distribution board and the SoC regulator
 * (both DEVTYPE 8) never get the same suggestion; explicit values are kept and reserved first.
 */
export function numbered(slots: VehicleSlot[]): VehicleSlot[] {
  const used = new Map<number, Set<number>>();
  const usedFor = (t: number): Set<number> => {
    let u = used.get(t);
    if (!u) used.set(t, (u = new Set()));
    return u;
  };
  for (const s of slots) if (s.suggestedNum !== undefined) for (const t of slotDevTypes(s)) usedFor(t).add(s.suggestedNum);
  return slots.map((s) => {
    if (s.suggestedNum !== undefined) return s;
    const types = slotDevTypes(s);
    let n = NUM_MIN;
    while (types.some((t) => usedFor(t).has(n))) n++;
    for (const t of types) usedFor(t).add(n);
    return { ...s, suggestedNum: n };
  });
}

export const gyroSlot = (required: boolean, pos: [number, number] = [0, 0.15]): VehicleSlot =>
  slot({ id: 'gyro', role: 'gyro', label: t('Jiroskop (yön)', 'Gyro (heading)'), accepts: ACCEPT.gyro, pos, required });

export const powerSlot = (required = false, pos: [number, number] = [0, -0.15]): VehicleSlot =>
  slot({ id: 'power', role: 'power', label: t('Güç dağıtım', 'Power distribution'), accepts: ACCEPT.power, pos, required });

export const socSlot = (pos: [number, number] = [0.3, -0.15]): VehicleSlot =>
  slot({ id: 'soc', role: 'computePower', label: t('SoC regülatörü', 'SoC regulator'), accepts: ACCEPT.soc, pos, required: false });

const r3 = (n: number): number => Math.round(n * 1000) / 1000;

/** Point at `deg` clockwise from the nose, radius `r` (nose is +y). */
export function polar(deg: number, r: number): [number, number] {
  const a = (deg * Math.PI) / 180;
  return [r3(r * Math.sin(a)), r3(r * Math.cos(a))];
}

export const DRIVE_PRESETS = { 'motor.idle_mode': 0 } as const;
export const PROP_PRESETS = { 'pwm.bidirectional': 0, 'motor.idle_mode': 1 } as const;
export const THRUSTER_PRESETS = { 'pwm.bidirectional': 1 } as const;
