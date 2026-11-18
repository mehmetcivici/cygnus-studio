import type { VehicleSlot, VehicleTemplate } from '../types';
import { ACCEPT, gyroSlot, numbered, powerSlot, slot, t } from './helpers';

export const defenseTurret: VehicleTemplate = {
  id: 'defense.turret',
  category: 'defense',
  name: t('Taret', 'Turret'),
  description: t('Yatay ve dikey eksen eyleyicileri, eksen encoder\'ları ve jiroskop.', 'Pan and tilt actuators with axis encoders and a gyro.'),
  competitions: ['Çelikkubbe'],
  shape: 'turret',
  size: { w: 1, h: 1 },
  slots: numbered([
    slot({ id: 'pan', role: 'pan', label: t('Yatay eksen', 'Pan axis'), accepts: ACCEPT.motorOrServo, pos: [0, 0.3] }),
    slot({ id: 'tilt', role: 'tilt', label: t('Dikey eksen', 'Tilt axis'), accepts: ACCEPT.motorOrServo, pos: [0.5, 0] }),
    slot({ id: 'pan.enc', role: 'encoder', label: t('Yatay encoder', 'Pan encoder'), accepts: ACCEPT.encoder, pos: [-0.3, 0.3], required: false }),
    slot({ id: 'tilt.enc', role: 'encoder', label: t('Dikey encoder', 'Tilt encoder'), accepts: ACCEPT.encoder, pos: [0.5, -0.3], required: false }),
    gyroSlot(false, [-0.3, -0.3]),
    powerSlot(false, [0, -0.6]),
  ]),
};

export const armArm4: VehicleTemplate = {
  id: 'arm.arm4',
  category: 'arm',
  name: t('Robot kol, 4 eksen', 'Robot arm, 4 axes'),
  description: t('4 eklem (sızdırmaz servo veya servo kanalı), kıskaç ve isteğe bağlı eklem encoder\'ları.', '4 joints (sealed servo or servo channel), gripper and optional joint encoders.'),
  competitions: ['Robot Kol'],
  shape: 'arm',
  size: { w: 0.6, h: 1.4 },
  slots: numbered(((): VehicleSlot[] => {
    const ys = [-0.8, -0.3, 0.2, 0.6];
    const joints = ys.flatMap((y, i) => [
      slot({ id: `j${i + 1}`, role: 'joint', group: `j${i + 1}`, label: t(`Eklem ${i + 1}`, `Joint ${i + 1}`), accepts: ACCEPT.servo, pos: [0, y] }),
      slot({ id: `j${i + 1}.enc`, role: 'jointEncoder', group: `j${i + 1}`, label: t(`Eklem ${i + 1} encoder`, `Joint ${i + 1} encoder`), accepts: ACCEPT.encoder, pos: [0.3, y], required: false }),
    ]);
    return [...joints, slot({ id: 'gripper', role: 'gripper', label: t('Kıskaç', 'Gripper'), accepts: ACCEPT.servo, pos: [0, 0.9], required: false })];
  })()),
};

export const customEmpty: VehicleTemplate = {
  id: 'custom.empty',
  category: 'custom',
  name: t('Boş şablon', 'Empty template'),
  description: t('Yuvaları kendiniz eklersiniz.', 'You add the slots yourself.'),
  competitions: [],
  shape: 'free',
  size: { w: 1, h: 1 },
  slots: [],
};

