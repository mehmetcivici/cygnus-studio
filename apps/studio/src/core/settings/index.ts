import { create } from 'zustand';
import { readStoredJson, writeStored } from '../../lib/storage';
import { setLang, useLangStore, type Lang } from '../../i18n';
import { useTheme, type ThemeName } from '../../ui';

export type AngleUnit = 'rot' | 'deg';
export type TempUnit = 'C' | 'F';
export type BusView = 'grid' | 'list';

export interface Settings {
  /** Show parameters flagged `advanced` and expert tools. */
  advanced: boolean;
  /** Display unit for catalog values in `rot` (raw stays `rot` on the wire and in files). */
  angleUnit: AngleUnit;
  tempUnit: TempUnit;
  /** Bus screen layout. */
  busView: BusView;
  /** Show CAN identifiers in hex (CAN monitor, device details). */
  hexIds: boolean;
}

const KEY = 'cy.settings';
export const DEFAULT_SETTINGS: Settings = { advanced: false, angleUnit: 'rot', tempUnit: 'C', busView: 'grid', hexIds: true };

function isPartialSettings(v: unknown): v is Partial<Settings> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function load(): Settings {
  const s = readStoredJson(KEY, isPartialSettings) ?? {};
  return {
    advanced: typeof s.advanced === 'boolean' ? s.advanced : DEFAULT_SETTINGS.advanced,
    angleUnit: s.angleUnit === 'deg' ? 'deg' : 'rot',
    tempUnit: s.tempUnit === 'F' ? 'F' : 'C',
    busView: s.busView === 'list' ? 'list' : 'grid',
    hexIds: typeof s.hexIds === 'boolean' ? s.hexIds : DEFAULT_SETTINGS.hexIds,
  };
}

/** Persistent preferences. Language and theme live in their own stores (re-exported below). */
export const useSettings = create<Settings>(() => load());

export function updateSettings(patch: Partial<Settings>): void {
  useSettings.setState(patch);
  writeStored(KEY, JSON.stringify(useSettings.getState()));
}

export function useLang(): Lang {
  return useLangStore((s) => s.lang);
}
export { setLang };
export function setTheme(theme: ThemeName): void {
  useTheme.getState().setTheme(theme);
}

/**
 * Converts a catalog value for display according to the unit preferences. Catalog units that
 * have no preference pass through unchanged.
 */
export function toDisplayUnit(value: number, unit: string, s: Pick<Settings, 'angleUnit' | 'tempUnit'> = useSettings.getState()): { value: number; unit: string } {
  if (s.angleUnit === 'deg') {
    if (unit === 'rot') return { value: value * 360, unit: '°' };
    if (unit === 'rps') return { value: value * 360, unit: '°/s' };
  }
  if (s.tempUnit === 'F' && unit === '°C') return { value: value * 1.8 + 32, unit: '°F' };
  return { value, unit };
}

/** Inverse of `toDisplayUnit` for values the user typed. */
export function fromDisplayUnit(value: number, unit: string, s: Pick<Settings, 'angleUnit' | 'tempUnit'> = useSettings.getState()): number {
  if (s.angleUnit === 'deg' && (unit === 'rot' || unit === 'rps')) return value / 360;
  if (s.tempUnit === 'F' && unit === '°C') return (value - 32) / 1.8;
  return value;
}
