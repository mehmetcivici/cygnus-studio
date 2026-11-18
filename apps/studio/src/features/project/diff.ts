import type { ModelDef, ParamDef } from '@cygnus/protocol';
import type { ProjectDevice } from '../../core';

export type DiffKind = 'param' | 'num' | 'name';

export interface DiffRow {
  /** `@num`, `@name` or the parameter key. */
  id: string;
  kind: DiffKind;
  key: string;
  def: ParamDef | undefined;
  project: number | string | undefined;
  card: number | string | undefined;
  same: boolean;
  /** Can be written to the board (not read-only, known to the catalog, present in the project). */
  writable: boolean;
}

export interface CardState {
  num: number;
  name: string;
  /** Parameter values read from the board. */
  params: Readonly<Record<string, number>>;
}

/** Values travel as f32 on the wire, so equality is relative to float precision. */
export function sameNumber(a: number, b: number): boolean {
  if (a === b) return true;
  return Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b));
}

/**
 * Row per identity field and per parameter present on either side, in catalog order.
 * `same` rows are kept so the caller can filter; read-only parameters never become writable.
 */
export function diffCard(project: Pick<ProjectDevice, 'num' | 'name' | 'params'>, card: CardState, def: ModelDef | undefined): DiffRow[] {
  const rows: DiffRow[] = [
    { id: '@num', kind: 'num', key: 'num', def: undefined, project: project.num, card: card.num, same: project.num === card.num, writable: project.num >= 1 && project.num <= 62 },
    { id: '@name', kind: 'name', key: 'name', def: undefined, project: project.name, card: card.name, same: project.name.trim() === card.name.trim(), writable: true },
  ];
  const keys = new Set([...Object.keys(project.params), ...Object.keys(card.params)]);
  const order = new Map((def?.params ?? []).map((p, i) => [p.key, i]));
  const sorted = [...keys].sort((a, b) => (order.get(a) ?? 1e6) - (order.get(b) ?? 1e6) || a.localeCompare(b));
  for (const key of sorted) {
    const pv = project.params[key];
    const cv = card.params[key];
    const pdef = def?.params.find((p) => p.key === key);
    rows.push({
      id: key,
      kind: 'param',
      key,
      def: pdef,
      project: pv,
      card: cv,
      same: pv !== undefined && cv !== undefined && sameNumber(pv, cv),
      writable: pv !== undefined && pdef !== undefined && !pdef.readOnly,
    });
  }
  return rows;
}

export const differing = (rows: readonly DiffRow[]): DiffRow[] => rows.filter((r) => !r.same);

/** "Update the project": copy the card's values of the chosen rows into the project board. */
export function copyCardToProject(device: ProjectDevice, rows: readonly DiffRow[]): ProjectDevice {
  const params = { ...device.params };
  let { num, name } = device;
  for (const r of rows) {
    if (r.kind === 'param' && typeof r.card === 'number') params[r.key] = r.card;
    else if (r.kind === 'num' && typeof r.card === 'number') num = r.card;
    else if (r.kind === 'name' && typeof r.card === 'string') name = r.card;
  }
  return { ...device, params, num, name };
}

/** A replacement board takes over the old board's slot in the project. */
export function replaceDevice(devices: readonly ProjectDevice[], oldUid48: string, next: { uid48: string; fw: string | null }): ProjectDevice[] {
  return devices.map((d) => (d.uid48 === oldUid48 ? { ...d, uid48: next.uid48, fw: next.fw ?? d.fw } : d));
}
