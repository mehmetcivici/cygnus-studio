import type { VehicleSlot, VehicleTemplate } from '../types';
import { ACCEPT, THRUSTER_PRESETS, gyroSlot, numbered, powerSlot, slot, socSlot, t } from './helpers';

const thruster = (id: string, tr: string, en: string, pos: [number, number], headingDeg?: number): VehicleSlot =>
  slot({ id, role: 'thruster', label: t(tr, en), accepts: ACCEPT.motorOrChannel, pos, presets: THRUSTER_PRESETS, ...(headingDeg !== undefined ? { headingDeg } : {}) });

// Vectored layout: each horizontal thruster axis is tangent to its corner so forward, strafe and yaw all mix.
const horizontal = (): VehicleSlot[] => [
  thruster('thr.h1', 'Yatay ön sağ', 'Horizontal front right', [0.7, 0.7], 315),
  thruster('thr.h2', 'Yatay ön sol', 'Horizontal front left', [-0.7, 0.7], 45),
  thruster('thr.h3', 'Yatay arka sağ', 'Horizontal rear right', [0.7, -0.7], 45),
  thruster('thr.h4', 'Yatay arka sol', 'Horizontal rear left', [-0.7, -0.7], 315),
];

const gripper = (): VehicleSlot =>
  slot({ id: 'gripper', role: 'gripper', label: t('Kıskaç', 'Gripper'), accepts: ACCEPT.servo, pos: [0, 0.9], required: false });

export const underwaterRov6: VehicleTemplate = {
  id: 'underwater.rov6',
  category: 'underwater',
  name: t('Su altı, 6 itici (vektörel)', 'Underwater, 6 thrusters (vectored)'),
  description: t('4 yatay (45°) ve 2 dikey itici; isteğe bağlı kıskaç.', '4 horizontal (45°) and 2 vertical thrusters; optional gripper.'),
  competitions: ['Su Altı'],
  shape: 'rov',
  size: { w: 1, h: 1.2 },
  slots: numbered([
    ...horizontal(),
    thruster('thr.v1', 'Dikey sağ', 'Vertical right', [0.4, 0]),
    thruster('thr.v2', 'Dikey sol', 'Vertical left', [-0.4, 0]),
    gripper(), gyroSlot(true), powerSlot(false), socSlot(),
  ]),
};

export const underwaterRov8: VehicleTemplate = {
  id: 'underwater.rov8',
  category: 'underwater',
  name: t('Su altı, 8 itici', 'Underwater, 8 thrusters'),
  description: t('4 yatay (45°) ve 4 dikey itici; isteğe bağlı kıskaç.', '4 horizontal (45°) and 4 vertical thrusters; optional gripper.'),
  competitions: ['Su Altı'],
  shape: 'rov',
  size: { w: 1, h: 1.2 },
  slots: numbered([
    ...horizontal(),
    thruster('thr.v1', 'Dikey ön sağ', 'Vertical front right', [0.35, 0.35]),
    thruster('thr.v2', 'Dikey ön sol', 'Vertical front left', [-0.35, 0.35]),
    thruster('thr.v3', 'Dikey arka sağ', 'Vertical rear right', [0.35, -0.35]),
    thruster('thr.v4', 'Dikey arka sol', 'Vertical rear left', [-0.35, -0.35]),
    gripper(), gyroSlot(true), powerSlot(false), socSlot(),
  ]),
};

export const surfaceUsv2: VehicleTemplate = {
  id: 'surface.usv2',
  category: 'surface',
  name: t('İDA, çift itici', 'USV, twin thrusters'),
  description: t('Diferansiyel itişli insansız deniz aracı.', 'Unmanned surface vessel with differential thrust.'),
  competitions: ['İDA'],
  shape: 'hull',
  size: { w: 0.8, h: 1.4 },
  slots: numbered([
    thruster('thr.l', 'Sol itici', 'Left thruster', [-0.45, -0.7], 0),
    thruster('thr.r', 'Sağ itici', 'Right thruster', [0.45, -0.7], 0),
    gyroSlot(true), powerSlot(false), socSlot(),
  ]),
};
