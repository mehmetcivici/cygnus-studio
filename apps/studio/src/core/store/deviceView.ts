import { DeviceState, type DeviceHandle, type DeviceFaults, type DeviceFlags, type FwVersion, type ModelDef, type Text } from '@cygnus/protocol';
import type { DeviceStatus } from '../../ui';

/**
 * Immutable snapshot of a DeviceHandle for React. A new object is made only when the handle
 * reported a change, so `useDevice` consumers and memoised rows skip unchanged boards.
 * Use `handle` for actions (`setParam`, `identify`, `control` …); never read fields from it in render.
 */
export interface DeviceView {
  readonly uid48: string;
  readonly handle: DeviceHandle;
  readonly driver: string;
  /** Legacy Cyncoder v3 (FRC protocol) board. */
  readonly legacy: boolean;
  readonly model: number;
  readonly def: ModelDef | undefined;
  readonly catalogStatus: DeviceHandle['catalogStatus'];
  readonly devType: number;
  readonly num: number;
  readonly name: string;
  readonly fw: FwVersion | null;
  readonly hwRev: number | null;
  readonly state: number;
  readonly flags: Readonly<DeviceFlags>;
  readonly faults: DeviceFaults;
  readonly online: boolean;
  readonly conflict: boolean;
  readonly unassigned: boolean;
  readonly bootloader: boolean;
  readonly infoLoaded: boolean;
  readonly status: DeviceStatus;
}

export const LEGACY_DRIVER_ID = 'cyncoder-v3';

export function deviceStatus(h: Pick<DeviceHandle, 'online' | 'state' | 'faults' | 'flags' | 'conflict' | 'unassigned' | 'bootloader'>): DeviceStatus {
  if (!h.online) return 'offline';
  if (h.state === DeviceState.BOOT || h.state === DeviceState.BOOTLOADER || h.bootloader) return 'boot';
  if (h.state === DeviceState.FAULT || h.state === DeviceState.ESTOP || h.faults.active !== 0) return 'fault';
  if (h.flags.warning || h.faults.warn !== 0 || h.faults.sticky !== 0 || h.conflict || h.unassigned) return 'warn';
  return 'ok';
}

export function makeDeviceView(h: DeviceHandle): DeviceView {
  return {
    uid48: h.uid48,
    handle: h,
    driver: h.driver,
    legacy: h.driver === LEGACY_DRIVER_ID,
    model: h.model,
    def: h.def,
    catalogStatus: h.catalogStatus,
    devType: h.devType,
    num: h.num,
    name: h.name,
    fw: h.fw ? { ...h.fw } : null,
    hwRev: h.hwRev,
    state: h.state,
    flags: { ...h.flags },
    faults: { active: h.faults.active, sticky: h.faults.sticky, warn: h.faults.warn, list: [...h.faults.list] },
    online: h.online,
    conflict: h.conflict,
    unassigned: h.unassigned,
    bootloader: h.bootloader,
    infoLoaded: h.infoLoaded,
    status: deviceStatus(h),
  };
}

export function fmtFw(fw: FwVersion | null): string {
  return fw ? `${fw.major}.${fw.minor}.${fw.patch}` : '—';
}

/** Model name shown everywhere; legacy boards get the product name users know them by. */
export const LEGACY_MODEL_NAME: Text = { tr: 'Cyncoder 1.4 (eski protokol)', en: 'Cyncoder 1.4 (legacy protocol)' };

export function modelText(v: Pick<DeviceView, 'legacy' | 'def' | 'model'>): Text {
  if (v.legacy) return LEGACY_MODEL_NAME;
  return v.def?.name ?? { tr: `Model ${v.model}`, en: `Model ${v.model}` };
}

/** Name for lists: the board name, else the model name. */
export function displayName(v: Pick<DeviceView, 'name' | 'legacy' | 'def' | 'model'>, lang: 'tr' | 'en'): string {
  return v.name.trim() || modelText(v)[lang] || modelText(v).tr;
}
