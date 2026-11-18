import type { LocalizedText, VehicleTemplate } from './types';
import * as T from './templates';

export * from './types';
export { validateTemplate, validateConfig } from './validate';
export type { TemplateIssue, ConfigIssue, ConfigIssueCode } from './validate';
export { planApply, fitName } from './plan';
export type { PlanDevice, PlanStep, PlanWarning, PlanResult } from './plan';
export { applyPlan, planDevices } from './apply';
export type { ApplyBus, ApplyStep, ApplyStepResult, ApplyResult, ApplyOptions } from './apply';
export { detectMovedEncoder, detectTiltedGyro } from './detect';
export type { DetectBus, DetectOptions, DetectEncoderOptions, DetectGyroOptions, DetectResult } from './detect';

export const templates: readonly VehicleTemplate[] = [
  T.frcSwerve4, T.frcTank, T.frcMecanum4,
  T.groundSkid4, T.groundSkid6, T.groundAckermann,
  T.airQuadX, T.airQuadPlus, T.airHexaX, T.airOctoX, T.airPlane,
  T.underwaterRov6, T.underwaterRov8, T.surfaceUsv2,
  T.defenseTurret, T.armArm4, T.customEmpty,
];

export function getTemplate(id: string): VehicleTemplate | undefined {
  return templates.find((x) => x.id === id);
}

export const templateCategories: readonly { id: VehicleTemplate['category']; name: LocalizedText }[] = [
  { id: 'frc', name: { tr: 'FRC', en: 'FRC' } },
  { id: 'ground', name: { tr: 'Kara aracı', en: 'Ground vehicle' } },
  { id: 'air', name: { tr: 'Hava aracı', en: 'Aerial vehicle' } },
  { id: 'underwater', name: { tr: 'Su altı', en: 'Underwater' } },
  { id: 'surface', name: { tr: 'Su üstü', en: 'Surface vessel' } },
  { id: 'defense', name: { tr: 'Savunma', en: 'Defense' } },
  { id: 'arm', name: { tr: 'Robot kol', en: 'Robot arm' } },
  { id: 'custom', name: { tr: 'Özel', en: 'Custom' } },
];
