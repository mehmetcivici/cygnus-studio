import type { SlotRole, VehicleSlot } from '@cygnus/vehicles';
import { defineProjectSection } from '../../core';
import { ALL_ROLES, type SlotTweak, type Tweaks } from './model';

/**
 * What the vehicle screen keeps in the project besides `project.vehicle` (the VehicleConfig,
 * owned by core): the user's own slots for the empty template and per-slot tweaks (direction,
 * gear ratio, number) that are folded into the template before planning.
 */
export interface VehicleSetup {
  customSlots: VehicleSlot[];
  tweaks: Tweaks;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isText = (v: unknown): boolean => isObj(v) && typeof v.tr === 'string' && typeof v.en === 'string';

export function isVehicleSlot(v: unknown): v is VehicleSlot {
  if (!isObj(v)) return false;
  if (typeof v.id !== 'string' || !ALL_ROLES.includes(v.role as SlotRole) || !isText(v.label) || typeof v.required !== 'boolean') return false;
  if (!isObj(v.pos) || !isNum(v.pos.x) || !isNum(v.pos.y)) return false;
  if (!Array.isArray(v.accepts) || !v.accepts.every((a) => isObj(a) && typeof a.model === 'string' && (a.via === 'device' || a.via === 'channel'))) return false;
  if (v.headingDeg !== undefined && !isNum(v.headingDeg)) return false;
  if (v.spin !== undefined && v.spin !== 'cw' && v.spin !== 'ccw') return false;
  return true;
}

function isTweak(v: unknown): v is SlotTweak {
  if (!isObj(v)) return false;
  return (v.invert === undefined || typeof v.invert === 'boolean') && (v.gearRatio === undefined || isNum(v.gearRatio)) && (v.num === undefined || isNum(v.num));
}

export function isVehicleSetup(v: unknown): v is VehicleSetup {
  return isObj(v) && Array.isArray(v.customSlots) && v.customSlots.every(isVehicleSlot) && isObj(v.tweaks) && Object.values(v.tweaks).every(isTweak);
}

export const vehicleSetup = defineProjectSection<VehicleSetup>('vehicle.setup', { initial: { customSlots: [], tweaks: {} }, validate: isVehicleSetup });
