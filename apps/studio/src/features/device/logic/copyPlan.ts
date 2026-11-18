import type { ModelDef } from '@cygnus/protocol';
import { diffParams, type DiffRow } from './paramFile';

/**
 * Settings that belong to one board's place on the robot rather than to its configuration:
 * offered in the copy preview but not selected by default.
 */
export const PER_BOARD_KEYS: readonly string[] = ['can.termination', 'fb.remote_num'];

export interface CopyTarget {
  uid48: string;
  /** Model key of the target; others are refused. */
  modelKey: string | undefined;
  /** The target's current values (as read from the board). */
  values: Readonly<Record<string, number>>;
}

export interface CopyTargetPlan {
  uid48: string;
  /** Every comparable row for the preview. */
  rows: DiffRow[];
  /** Keys that will be written, in catalog order. */
  writes: string[];
  /** Target is another model: nothing is copied. */
  wrongModel: boolean;
}

export interface CopyPlan {
  /** Keys taken from the source (writable, valid, selected). */
  keys: string[];
  targets: CopyTargetPlan[];
  /** Total parameter writes. */
  total: number;
}

/** Source keys that can be copied: writable catalog parameters with a value. */
export function copyableKeys(def: ModelDef, source: Readonly<Record<string, number>>): string[] {
  return def.params.filter((p) => !p.readOnly && source[p.key] !== undefined).map((p) => p.key);
}

/** Default selection for the copy dialog: everything except per-board settings. */
export function defaultCopySelection(def: ModelDef, source: Readonly<Record<string, number>>): Set<string> {
  return new Set(copyableKeys(def, source).filter((k) => !PER_BOARD_KEYS.includes(k)));
}

/**
 * Plan for copying the source board's settings to same-model targets. Only `selected` keys
 * that differ on a target are written; the source itself is skipped. Number and name are
 * not parameters and are never part of a plan.
 */
export function planCopy(
  def: ModelDef,
  sourceUid: string,
  source: Readonly<Record<string, number>>,
  targets: readonly CopyTarget[],
  selected: ReadonlySet<string>,
): CopyPlan {
  const keys = copyableKeys(def, source).filter((k) => selected.has(k));
  const incoming: Record<string, number> = {};
  for (const k of keys) incoming[k] = source[k] as number;
  const plans: CopyTargetPlan[] = targets
    .filter((t) => t.uid48 !== sourceUid)
    .map((t) => {
      if (t.modelKey !== def.key) return { uid48: t.uid48, rows: [], writes: [], wrongModel: true };
      const rows = diffParams(def, t.values, incoming);
      return { uid48: t.uid48, rows, writes: rows.filter((r) => r.status === 'change').map((r) => r.key), wrongModel: false };
    });
  return { keys, targets: plans, total: plans.reduce((n, p) => n + p.writes.length, 0) };
}
