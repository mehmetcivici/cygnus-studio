import type { DiffRow } from './diff';

/** The slice of a board handle the restore needs (a fake in tests). */
export interface RestoreTarget {
  setParam(key: string, value: number): Promise<number>;
  rename(name: string): Promise<void>;
  save(): Promise<void>;
}

export interface RestoreOptions {
  /** Persist to the board's flash afterwards (only when something was written). */
  save: boolean;
  /** Changes the board's number; throws when it is taken. */
  assignNum: (num: number) => Promise<void>;
  onStep?: (done: number, total: number) => void;
}

export interface RestoreResult {
  id: string;
  ok: boolean;
  error?: unknown;
}

export interface RestoreSummary {
  results: RestoreResult[];
  written: number;
  failed: number;
  saved: boolean;
  saveError?: unknown;
}

/**
 * Writes the project's values of the chosen rows to a board. The number goes first (the board
 * answers on the new address afterwards), then the name, then parameters; one failure does not
 * stop the rest. Rows that are not writable are ignored.
 */
export async function restoreToCard(target: RestoreTarget, rows: readonly DiffRow[], opts: RestoreOptions): Promise<RestoreSummary> {
  const todo = rows.filter((r) => r.writable && r.project !== undefined);
  const rank = (r: DiffRow): number => (r.kind === 'num' ? 0 : r.kind === 'name' ? 1 : 2);
  const ordered = [...todo].sort((a, b) => rank(a) - rank(b));
  const results: RestoreResult[] = [];
  for (let i = 0; i < ordered.length; i++) {
    const r = ordered[i];
    if (!r) continue;
    try {
      if (r.kind === 'num' && typeof r.project === 'number') await opts.assignNum(r.project);
      else if (r.kind === 'name' && typeof r.project === 'string') await target.rename(r.project);
      else if (r.kind === 'param' && typeof r.project === 'number') await target.setParam(r.key, r.project);
      results.push({ id: r.id, ok: true });
    } catch (error) {
      results.push({ id: r.id, ok: false, error });
    }
    opts.onStep?.(i + 1, ordered.length);
  }
  const written = results.filter((r) => r.ok).length;
  let saved = false;
  let saveError: unknown;
  if (opts.save && written > 0) {
    try {
      await target.save();
      saved = true;
    } catch (e) {
      saveError = e;
    }
  }
  return { results, written, failed: results.length - written, saved, saveError };
}
