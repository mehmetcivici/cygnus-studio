import type { VehicleTemplate } from '../types';
import { ACCEPT, DRIVE_PRESETS, gyroSlot, numbered, powerSlot, slot, t } from './helpers';

const MODULES = [
  { id: 'fl', x: -0.6, y: 0.6, tr: 'Ön sol', en: 'Front left' },
  { id: 'fr', x: 0.6, y: 0.6, tr: 'Ön sağ', en: 'Front right' },
  { id: 'bl', x: -0.6, y: -0.6, tr: 'Arka sol', en: 'Back left' },
  { id: 'br', x: 0.6, y: -0.6, tr: 'Arka sağ', en: 'Back right' },
] as const;

const STEER_PRESETS = { 'motor.idle_mode': 0, 'fb.source': 2, 'fb.remote_ratio': 1, 'pos.kp': 30, 'pos.kd': 0.4 } as const;

export const frcSwerve4: VehicleTemplate = {
  id: 'frc.swerve4',
  category: 'frc',
  name: t('Swerve şase', 'Swerve drivetrain'),
  description: t('4 modül: her birinde sürüş motoru, dönüş motoru ve mutlak dönüş encoder\'ı.', '4 modules, each with a drive motor, a steer motor and an absolute steer encoder.'),
  competitions: ['FRC'],
  shape: 'rect',
  size: { w: 1, h: 1 },
  slots: [
    ...MODULES.flatMap((m, i) => {
      const sx = Math.sign(m.x);
      return [
        slot({ id: `${m.id}.drive`, role: 'drive', group: m.id, label: t(`${m.tr} · sürüş`, `${m.en} · drive`), accepts: ACCEPT.motor, pos: [m.x, m.y + 0.16], headingDeg: 0, suggestedNum: i + 1, presets: DRIVE_PRESETS }),
        // Steer motors read the module angle from the remote Cyncoder so the loop closes on the wheel, not the motor.
        // Starting gains for a typical NEO 550 + 150/7 steer stage; the factory default would not overcome the module's friction.
        slot({ id: `${m.id}.steer`, role: 'steer', group: m.id, label: t(`${m.tr} · dönüş`, `${m.en} · steer`), accepts: ACCEPT.motor, pos: [m.x - sx * 0.16, m.y - 0.1], suggestedNum: i + 5, presets: STEER_PRESETS }),
        slot({ id: `${m.id}.enc`, role: 'steerEncoder', group: m.id, label: t(`${m.tr} · encoder`, `${m.en} · encoder`), accepts: ACCEPT.encoder, pos: [m.x + sx * 0.16, m.y - 0.1], suggestedNum: i + 1 }),
      ];
    }),
    gyroSlot(true),
    powerSlot(false),
  ],
};

export const frcTank: VehicleTemplate = {
  id: 'frc.tank',
  category: 'frc',
  name: t('Tank (diferansiyel)', 'Tank (differential)'),
  description: t('Sol ve sağ tarafta 2 veya 3 motor; isteğe bağlı encoder\'lar.', '2 or 3 motors per side; optional encoders.'),
  competitions: ['FRC'],
  shape: 'rect',
  size: { w: 1, h: 1.2 },
  slots: numbered([
    ...(['l', 'r'] as const).flatMap((side) => {
      const x = side === 'l' ? -0.65 : 0.65;
      const tr = side === 'l' ? 'Sol' : 'Sağ';
      const en = side === 'l' ? 'Left' : 'Right';
      return [0, 1, 2].map((k) =>
        slot({ id: `${side}.${k + 1}`, role: 'drive', group: side, label: t(`${tr} ${k + 1} · sürüş`, `${en} ${k + 1} · drive`), accepts: ACCEPT.motor, pos: [x, [0.6, 0, -0.6][k] ?? 0], headingDeg: 0, required: k === 0, presets: DRIVE_PRESETS }),
      );
    }),
    slot({ id: 'enc.l', role: 'encoder', label: t('Sol encoder', 'Left encoder'), accepts: ACCEPT.encoder, pos: [-0.3, 0], required: false }),
    slot({ id: 'enc.r', role: 'encoder', label: t('Sağ encoder', 'Right encoder'), accepts: ACCEPT.encoder, pos: [0.3, 0], required: false }),
    gyroSlot(false, [0, 0.3]),
    powerSlot(false, [0, -0.3]),
  ]),
};

export const frcMecanum4: VehicleTemplate = {
  id: 'frc.mecanum4',
  category: 'frc',
  name: t('Mecanum şase', 'Mecanum drivetrain'),
  description: t('4 mecanum tekerlek, jiroskop ve güç dağıtım.', 'Four mecanum wheels, a gyro and power distribution.'),
  competitions: ['FRC'],
  shape: 'rect',
  size: { w: 1, h: 1 },
  slots: numbered([
    ...MODULES.map((m) => slot({ id: `${m.id}.drive`, role: 'drive', group: m.id, label: t(`${m.tr} · sürüş`, `${m.en} · drive`), accepts: ACCEPT.motor, pos: [m.x, m.y], headingDeg: 0, presets: DRIVE_PRESETS })),
    gyroSlot(false),
    powerSlot(false),
  ]),
};
