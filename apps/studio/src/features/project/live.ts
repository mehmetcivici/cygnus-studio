import { useMemo } from 'react';
import { getModel } from '@cygnus/protocol';
import { useDevices, type DeviceView, type ProjectDevice } from '../../core';
import type { LiveCard } from './match';
import type { CodeCard } from './codegen';

export function liveCardOf(v: DeviceView): LiveCard {
  return { uid48: v.uid48, model: v.model, devType: v.devType, num: v.num, name: v.name, online: v.online, legacy: v.legacy, unresolved: v.unassigned || v.conflict };
}

/** Boards on the bus as plain data (stable between unrelated store updates). */
export function useLiveCards(): { views: readonly DeviceView[]; cards: LiveCard[] } {
  const views = useDevices();
  const cards = useMemo(() => views.map(liveCardOf), [views]);
  return { views, cards };
}

export function projectDeviceOf(v: DeviceView, params: Record<string, number>): ProjectDevice {
  return {
    uid48: v.uid48,
    driver: v.driver,
    model: v.model,
    modelKey: v.def?.key ?? `model${v.model}`,
    devType: v.devType,
    num: v.num,
    name: v.name,
    fw: v.fw ? `${v.fw.major}.${v.fw.minor}.${v.fw.patch}` : null,
    params,
  };
}

export function codeCardOfProject(d: ProjectDevice): CodeCard {
  const def = getModel(d.model);
  return { name: d.name, devType: d.devType, num: d.num, model: d.model, modelKey: def?.key ?? d.modelKey, def };
}

export function codeCardOfLive(v: DeviceView): CodeCard {
  return { name: v.name, devType: v.devType, num: v.num, model: v.model, modelKey: v.def?.key ?? `model${v.model}`, def: v.def };
}

export interface SectionShape {
  kind: 'list' | 'object' | 'value';
  count: number;
}

/** Feature-owned project sections are opaque to this screen; only their rough size is shown. */
export function sectionShape(value: unknown): SectionShape {
  if (Array.isArray(value)) return { kind: 'list', count: value.length };
  if (typeof value === 'object' && value !== null) return { kind: 'object', count: Object.keys(value).length };
  return { kind: 'value', count: value === undefined || value === null || value === '' ? 0 : 1 };
}

/** `tuner.runs` → `tuner`; used to pick a readable section label. */
export const sectionOwner = (id: string): string => id.split('.')[0] ?? id;
