import type { VehicleTemplate, VehicleSlot } from '../types';
import { ACCEPT, PROP_PRESETS, gyroSlot, numbered, polar, powerSlot, slot, socSlot, t } from './helpers';

interface Motor { n: number; pos: [number, number]; spin: 'cw' | 'ccw'; tr: string; en: string }

const motorSlot = (m: Motor): VehicleSlot =>
  slot({ id: `m${m.n}`, role: 'propeller', label: t(`Motor ${m.n} · ${m.tr}`, `Motor ${m.n} · ${m.en}`), accepts: ACCEPT.motorOrChannel, pos: m.pos, spin: m.spin, suggestedNum: m.n, presets: PROP_PRESETS });

function multirotor(id: string, shape: VehicleTemplate['shape'], name: VehicleTemplate['name'], description: VehicleTemplate['description'], motors: Motor[]): VehicleTemplate {
  return {
    id, category: 'air', name, description,
    competitions: ['İHA', 'Savaşan İHA'],
    shape, size: { w: 1, h: 1 },
    slots: numbered([...[...motors].sort((a, b) => a.n - b.n).map(motorSlot), gyroSlot(true), powerSlot(false, [0, -0.2]), socSlot([0.25, -0.2])]),
  };
}

// Motor numbering and spin follow the ArduPilot frame layouts.
// Source: ArduPilot AP_MotorsMatrix.cpp setup_quad_matrix, MOTOR_FRAME_TYPE_X (motor number = array index + 1).
export const airQuadX =multirotor('air.quadx', 'x-frame', t('Quadcopter X', 'Quadcopter X'), t('4 pervane, X düzeni (ArduPilot motor sırası).', 'Four propellers in X layout (ArduPilot motor order).'), [
  { n: 1, pos: [0.6, 0.6], spin: 'ccw', tr: 'ön sağ', en: 'front right' },
  { n: 2, pos: [-0.6, -0.6], spin: 'ccw', tr: 'arka sol', en: 'rear left' },
  { n: 3, pos: [-0.6, 0.6], spin: 'cw', tr: 'ön sol', en: 'front left' },
  { n: 4, pos: [0.6, -0.6], spin: 'cw', tr: 'arka sağ', en: 'rear right' },
]);

// Source: ArduPilot AP_MotorsMatrix.cpp setup_quad_matrix, MOTOR_FRAME_TYPE_PLUS.
export const airQuadPlus =multirotor('air.quadplus', 'plus-frame', t('Quadcopter +', 'Quadcopter +'), t('4 pervane, + düzeni (ArduPilot motor sırası).', 'Four propellers in + layout (ArduPilot motor order).'), [
  { n: 1, pos: [0.7, 0], spin: 'ccw', tr: 'sağ', en: 'right' },
  { n: 2, pos: [-0.7, 0], spin: 'ccw', tr: 'sol', en: 'left' },
  { n: 3, pos: [0, 0.7], spin: 'cw', tr: 'ön', en: 'front' },
  { n: 4, pos: [0, -0.7], spin: 'cw', tr: 'arka', en: 'rear' },
]);

// Quadrant-style name from the bearing; the motor number disambiguates neighbours in the same quadrant.
const side = (deg: number): { tr: string; en: string } => {
  const [x, y] = polar(deg, 1);
  const fb = y > 0.3 ? ['ön', 'front'] : y < -0.3 ? ['arka', 'rear'] : ['', ''];
  const lr = x > 0.3 ? ['sağ', 'right'] : x < -0.3 ? ['sol', 'left'] : ['', ''];
  return { tr: [fb[0], lr[0]].filter(Boolean).join(' '), en: [fb[1], lr[1]].filter(Boolean).join(' ') };
};

const ring = (spec: [number, number, 'cw' | 'ccw'][], r: number): Motor[] =>
  spec.map(([n, deg, spin]) => ({ n, pos: polar(deg, r), spin, ...side(deg) }));

// Source: ArduPilot AP_MotorsMatrix.cpp setup_hexa_matrix, MOTOR_FRAME_TYPE_X.
export const airHexaX =multirotor('air.hexax', 'hexa-frame', t('Hexacopter X', 'Hexacopter X'), t('6 pervane, X düzeni (ArduPilot motor sırası).', 'Six propellers in X layout (ArduPilot motor order).'),
  ring([[1, 90, 'cw'], [2, -90, 'ccw'], [3, -30, 'cw'], [4, 150, 'ccw'], [5, 30, 'ccw'], [6, -150, 'cw']], 0.8));

// Source: ArduPilot AP_MotorsMatrix.cpp setup_octa_matrix, MOTOR_FRAME_TYPE_X.
export const airOctoX =multirotor('air.octox', 'octo-frame', t('Oktokopter X', 'Octocopter X'), t('8 pervane, X düzeni (yan komşular ters yönde döner).', 'Eight propellers in X layout (neighbours counter-rotate).'),
  ring([[1, 22.5, 'cw'], [2, -157.5, 'cw'], [3, 67.5, 'ccw'], [4, 157.5, 'ccw'], [5, -22.5, 'ccw'], [6, -112.5, 'ccw'], [7, -67.5, 'cw'], [8, 112.5, 'cw']], 0.8));

export const airPlane: VehicleTemplate = {
  id: 'air.plane',
  category: 'air',
  name: t('Sabit kanat', 'Fixed wing'),
  description: t('Tek itki motoru ve servo kontrol yüzeyleri.', 'Single thrust motor with servo-driven control surfaces.'),
  competitions: ['Savaşan İHA', 'İHA'],
  shape: 'plane',
  size: { w: 1.4, h: 1 },
  slots: numbered([
    slot({ id: 'motor', role: 'propeller', label: t('İtki motoru', 'Thrust motor'), accepts: ACCEPT.motorOrChannel, pos: [0, 0.85], presets: PROP_PRESETS }),
    slot({ id: 'ail.l', role: 'surface', label: t('Sol kanatçık', 'Left aileron'), accepts: ACCEPT.servo, pos: [-0.75, 0.05] }),
    slot({ id: 'ail.r', role: 'surface', label: t('Sağ kanatçık', 'Right aileron'), accepts: ACCEPT.servo, pos: [0.75, 0.05] }),
    slot({ id: 'elev', role: 'surface', label: t('İrtifa dümeni', 'Elevator'), accepts: ACCEPT.servo, pos: [0, -0.6] }),
    slot({ id: 'rud', role: 'surface', label: t('Yön dümeni', 'Rudder'), accepts: ACCEPT.servo, pos: [0, -0.85], required: false }),
    gyroSlot(true),
    powerSlot(false, [0, -0.2]),
    socSlot([0.2, -0.2]),
  ]),
};
