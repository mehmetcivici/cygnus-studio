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

/** Cards of one family share a number space (same devType), so slots are numbered per family. */
function family(s: VehicleSlot): string {
  const m = s.accepts[0]?.model ?? '';
  if (m.startsWith('esc')) return 'esc';
  if (m === 'sealed_servo' || m === 'servo16') return 'servo';
  if (m.startsWith('pdh')) return 'pdh';
  return m;
}

/** Fills missing suggestedNum values in slot order, per device family. */
export function numbered(slots: VehicleSlot[]): VehicleSlot[] {
  const counters = new Map<string, number>();
  return slots.map((s) => {
    if (s.suggestedNum !== undefined) return s;
    const f = family(s);
    const n = (counters.get(f) ?? 0) + 1;
    counters.set(f, n);
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
