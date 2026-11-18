import { CYNCODER } from './models/cyncoder';
import { ESC_20A, ESC_80A } from './models/esc';
import { GYRO } from './models/gyro';
import { POWER_DIST_LARGE, POWER_DIST_SMALL, SOC_REGULATOR } from './models/power';
import { SEALED_SERVO } from './models/sealed-servo';
import { SERVO16 } from './models/servo16';
import { DEBUG_OLED, USB_CAN } from './models/tools';
import type { ActionDef, ModelDef, ParamDef, SignalDef, StatusFrameDef } from './schema';

/** All models, ordered by model code. */
export const CATALOG: readonly ModelDef[] = [
  ESC_20A,
  ESC_80A,
  CYNCODER,
  GYRO,
  SERVO16,
  SEALED_SERVO,
  POWER_DIST_SMALL,
  POWER_DIST_LARGE,
  SOC_REGULATOR,
  DEBUG_OLED,
  USB_CAN,
];

const byModel = new Map<number, ModelDef>(CATALOG.map((m) => [m.model, m]));

export function getModel(model: number): ModelDef | undefined {
  return byModel.get(model);
}

interface ModelIndex {
  paramKey: Map<string, ParamDef>;
  paramId: Map<number, ParamDef>;
  signalKey: Map<string, SignalDef>;
  signalSid: Map<number, SignalDef>;
  status: Map<number, StatusFrameDef>;
  action: Map<number, ActionDef>;
}

// Lazily built per model so lookups stay O(1) on hot paths without mutating the definitions.
const indexes = new WeakMap<ModelDef, ModelIndex>();

function indexOf(def: ModelDef): ModelIndex {
  let ix = indexes.get(def);
  if (!ix) {
    ix = {
      paramKey: new Map(def.params.map((p) => [p.key, p])),
      paramId: new Map(def.params.map((p) => [p.pid, p])),
      signalKey: new Map(def.signals.map((s) => [s.key, s])),
      signalSid: new Map(def.signals.map((s) => [s.sid, s])),
      status: new Map(def.statusFrames.map((f) => [f.index, f])),
      action: new Map(def.actions.map((a) => [a.cmd, a])),
    };
    indexes.set(def, ix);
  }
  return ix;
}

export function paramByKey(def: ModelDef, key: string): ParamDef | undefined {
  return indexOf(def).paramKey.get(key);
}

export function paramById(def: ModelDef, pid: number): ParamDef | undefined {
  return indexOf(def).paramId.get(pid);
}

export function signalByKey(def: ModelDef, key: string): SignalDef | undefined {
  return indexOf(def).signalKey.get(key);
}

export function signalBySid(def: ModelDef, sid: number): SignalDef | undefined {
  return indexOf(def).signalSid.get(sid);
}

export function statusFrameByIndex(def: ModelDef, index: number): StatusFrameDef | undefined {
  return indexOf(def).status.get(index);
}

export function actionByCmd(def: ModelDef, cmd: number): ActionDef | undefined {
  return indexOf(def).action.get(cmd);
}
