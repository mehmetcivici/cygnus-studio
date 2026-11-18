import type { ComponentType } from 'react';
import type { VizId } from '../logic/viz';
import type { VizProps } from './shared';
import { VizEsc } from './VizEsc';
import { VizEncoder, VizLegacyEncoder } from './VizEncoder';
import { VizGyro } from './VizGyro';
import { VizSealedServo, VizServo16 } from './VizServo';
import { VizPdhLarge, VizPdhSmall, VizSoc } from './VizPower';
import { VizOled } from './VizOled';

export type { VizProps } from './shared';

/** Component per visualisation id (selection logic lives in `logic/viz.ts`). */
export const VIZ_COMPONENTS: Record<VizId, ComponentType<VizProps>> = {
  esc: VizEsc,
  encoder: VizEncoder,
  legacyEncoder: VizLegacyEncoder,
  gyro: VizGyro,
  servo16: VizServo16,
  sealedServo: VizSealedServo,
  pdhLarge: VizPdhLarge,
  pdhSmall: VizPdhSmall,
  soc: VizSoc,
  oled: VizOled,
};
