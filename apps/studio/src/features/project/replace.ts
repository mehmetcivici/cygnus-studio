import type { ModelDef, ReadAllResult } from '@cygnus/protocol';
import type { ProjectDevice } from '../../core';
import { diffCard, differing } from './diff';
import { restoreToCard, type RestoreSummary, type RestoreTarget } from './restore';

export interface ReplaceTarget extends RestoreTarget {
  readonly uid48: string;
  readonly num: number;
  readonly name: string;
  readAllParams(): Promise<ReadAllResult>;
}

export interface ReplaceBus {
  assignId(uid48: string, num: number, opts: { persist?: boolean; force?: boolean }): Promise<void>;
  /** Drops a lost board from the bus list. */
  forget(uid48: string): boolean;
}

export interface ReplaceOutcome {
  /** The board took the project's number (or already had it). */
  numberSet: boolean;
  numberError?: unknown;
  summary: RestoreSummary | null;
  readFailed: number;
}

/**
 * "Install the spare with the same settings": the replacement gets the dead board's number (forced,
 * the dead board still holds it in the host's list), then only what differs is written, saved to
 * flash, and the dead board is dropped from the bus list. A factory-fresh board has no number, so
 * it cannot be read before it is numbered; that is why the number goes first.
 */
export async function installReplacement(
  bus: ReplaceBus,
  target: ReplaceTarget,
  project: ProjectDevice,
  def: ModelDef | undefined,
  onStep?: (done: number, total: number) => void,
): Promise<ReplaceOutcome> {
  let numberSet = target.num === project.num;
  let numberError: unknown;
  if (!numberSet) {
    try {
      await bus.assignId(target.uid48, project.num, { persist: true, force: true });
      numberSet = true;
    } catch (e) {
      numberError = e;
    }
  }
  if (!numberSet) return { numberSet, numberError, summary: null, readFailed: 0 };
  const read = await target.readAllParams();
  const rows = differing(diffCard(project, { num: project.num, name: target.name, params: read.values }, def)).filter((r) => r.kind !== 'num');
  const summary = await restoreToCard(target, rows, { save: true, assignNum: async () => undefined, onStep });
  if (summary.failed === 0) bus.forget(project.uid48);
  return { numberSet, summary, readFailed: read.failed.length };
}
