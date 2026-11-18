import type { ModelCategory, ModelDef, SignalDef } from '@cygnus/protocol';

/** Model-specific visualisations of the Overview tab (presentation only; data comes from catalog signals). */
export type VizId = 'esc' | 'encoder' | 'legacyEncoder' | 'gyro' | 'servo16' | 'sealedServo' | 'pdhLarge' | 'pdhSmall' | 'soc' | 'oled';

interface VizEntry {
  id: VizId;
  /** Catalog model keys this visualisation is made for. */
  keys?: readonly string[];
  /** Fallback for future models of the same family (only when every required signal exists). */
  category?: ModelCategory;
  /** Signals the visualisation reads; a model lacking any of them falls back to tiles only. */
  requires: readonly string[];
  /** Signals already drawn by the visualisation, left out of the tile grid (prefix match with `*`). */
  hideTiles?: readonly string[];
}

/** Ordered: the first entry whose keys (or category + required signals) match wins. */
export const VIZ_TABLE: readonly VizEntry[] = [
  { id: 'esc', keys: ['esc20a', 'esc80a'], category: 'motor', requires: ['velocity', 'bus.current', 'duty', 'temp.fet'] },
  { id: 'encoder', keys: ['cyncoder'], requires: ['abs.position', 'position', 'magnet.status'] },
  { id: 'legacyEncoder', keys: ['cyncoder_v3'], requires: ['position', 'magnet.health'], hideTiles: ['position.deg', 'velocity.dps', 'abs.ticks'] },
  { id: 'gyro', keys: ['gyro'], requires: ['yaw', 'pitch', 'roll'], hideTiles: ['quat.*', 'accel.*', 'gyro.*'] },
  { id: 'servo16', keys: ['servo16'], requires: ['ch.1.pulse'], hideTiles: ['ch.*'] },
  { id: 'sealedServo', keys: ['sealed_servo'], requires: ['position', 'setpoint'] },
  { id: 'pdhLarge', keys: ['pdh_large'], requires: ['ch.1.current', 'fuse.mask'], hideTiles: ['ch.*', 'fuse.mask', 'aux*'] },
  { id: 'pdhSmall', keys: ['pdh_small'], requires: ['input.voltage', 'fuse.mask'], hideTiles: ['fuse.mask'] },
  { id: 'soc', keys: ['soc_reg'], requires: ['input.voltage', 'output.voltage'] },
  { id: 'oled', keys: ['oled'], requires: [] },
];

function hasAll(def: ModelDef, keys: readonly string[]): boolean {
  return keys.every((k) => def.signals.some((s) => s.key === k));
}

/** Visualisation for a board, or null (unknown model, or a model without one): tiles only. */
export function pickVisualization(def: ModelDef | undefined): VizId | null {
  if (!def) return null;
  const byKey = VIZ_TABLE.find((e) => e.keys?.includes(def.key));
  if (byKey) return hasAll(def, byKey.requires) ? byKey.id : null;
  const byCat = VIZ_TABLE.find((e) => e.category === def.category && hasAll(def, e.requires));
  return byCat?.id ?? null;
}

function matchesPattern(key: string, pattern: string): boolean {
  return pattern.endsWith('*') ? key.startsWith(pattern.slice(0, -1)) : key === pattern;
}

/** Signals shown as live tiles next to the visualisation, in catalog order. */
export function tileSignals(def: ModelDef | undefined, viz: VizId | null): SignalDef[] {
  if (!def) return [];
  const hide = VIZ_TABLE.find((e) => e.id === viz)?.hideTiles ?? [];
  return def.signals.filter((s) => !hide.some((p) => matchesPattern(s.key, p)));
}
