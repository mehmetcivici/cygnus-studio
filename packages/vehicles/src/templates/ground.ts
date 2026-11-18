import type { VehicleTemplate } from '../types';
import { ACCEPT, DRIVE_PRESETS, gyroSlot, numbered, powerSlot, slot, socSlot, t } from './helpers';

const WHEELS = {
  fl: ['Ön sol', 'Front left'], fr: ['Ön sağ', 'Front right'],
  ml: ['Orta sol', 'Middle left'], mr: ['Orta sağ', 'Middle right'],
  rl: ['Arka sol', 'Rear left'], rr: ['Arka sağ', 'Rear right'],
} as const;

function wheel(id: keyof typeof WHEELS, x: number, y: number) {
  const [tr, en] = WHEELS[id];
  return slot({ id: `${id}.drive`, role: 'drive', group: id, label: t(`${tr} · sürüş`, `${en} · drive`), accepts: ACCEPT.motor, pos: [x, y], headingDeg: 0, presets: DRIVE_PRESETS });
}

export const groundSkid4: VehicleTemplate = {
  id: 'ground.skid4',
  category: 'ground',
  name: t('İKA 4 teker', 'UGV 4 wheels'),
  description: t('Paletli/kaydırmalı dönüşlü 4 tekerlekli kara aracı.', 'Skid-steer ground vehicle with four driven wheels.'),
  competitions: ['İKA'],
  shape: 'rect',
  size: { w: 1, h: 1.2 },
  slots: numbered([wheel('fl', -0.7, 0.6), wheel('fr', 0.7, 0.6), wheel('rl', -0.7, -0.6), wheel('rr', 0.7, -0.6), gyroSlot(false), powerSlot(false), socSlot()]),
};

export const groundSkid6: VehicleTemplate = {
  id: 'ground.skid6',
  category: 'ground',
  name: t('İKA 6 teker', 'UGV 6 wheels'),
  description: t('6 tekerlekli kaydırmalı dönüşlü kara aracı.', 'Skid-steer ground vehicle with six driven wheels.'),
  competitions: ['İKA'],
  shape: 'rect',
  size: { w: 1, h: 1.4 },
  slots: numbered([wheel('fl', -0.7, 0.7), wheel('fr', 0.7, 0.7), wheel('ml', -0.7, 0), wheel('mr', 0.7, 0), wheel('rl', -0.7, -0.7), wheel('rr', 0.7, -0.7), gyroSlot(false), powerSlot(false), socSlot()]),
};

export const groundAckermann: VehicleTemplate = {
  id: 'ground.ackermann',
  category: 'ground',
  name: t('Ackermann (Robotaksi)', 'Ackermann (robotaxi)'),
  description: t('Direksiyonlu araç: 1–2 sürüş motoru ve direksiyon eyleyicisi.', 'Steered vehicle: 1–2 drive motors and a steering actuator.'),
  competitions: ['Robotaksi'],
  shape: 'rect',
  size: { w: 0.9, h: 1.5 },
  slots: numbered([
    slot({ id: 'drive.1', role: 'drive', label: t('Sürüş 1 · arka', 'Drive 1 · rear'), accepts: ACCEPT.motor, pos: [-0.3, -0.6], headingDeg: 0, presets: DRIVE_PRESETS }),
    slot({ id: 'drive.2', role: 'drive', label: t('Sürüş 2 · arka', 'Drive 2 · rear'), accepts: ACCEPT.motor, pos: [0.3, -0.6], headingDeg: 0, required: false, presets: DRIVE_PRESETS }),
    slot({ id: 'steer', role: 'steer', label: t('Direksiyon', 'Steering'), accepts: ACCEPT.motorOrServo, pos: [0, 0.6] }),
    slot({ id: 'steer.enc', role: 'steerEncoder', label: t('Direksiyon encoder', 'Steering encoder'), accepts: ACCEPT.encoder, pos: [0.3, 0.6], required: false }),
    gyroSlot(false),
    powerSlot(false),
    socSlot(),
  ]),
};
