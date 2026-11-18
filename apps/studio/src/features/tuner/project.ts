import { defineProjectSection } from '../../core';
import { EMPTY_SECTION, isTunerSection, loopId, type GainSetId, type Gains, type LoopConfig, type TunerRun, type TunerSection } from './types';

/** Runs, A/B gain sets, per-loop test settings and notes live in the project file. */
export const tunerSection = defineProjectSection<TunerSection>('tuner', { initial: EMPTY_SECTION, validate: isTunerSection, version: 1 });

/** Oldest runs beyond this are dropped (each run keeps ≤ RUN_POINTS samples). */
export const MAX_RUNS = 60;

export function addRun(run: TunerRun): void {
  tunerSection.set((s) => {
    const runs = [...s.runs, run];
    return { ...s, runs: runs.length > MAX_RUNS ? runs.slice(runs.length - MAX_RUNS) : runs };
  });
}

export function updateRun(id: string, patch: Partial<Pick<TunerRun, 'note'>>): void {
  tunerSection.set((s) => ({ ...s, runs: s.runs.map((r) => (r.id === id ? { ...r, ...patch } : r)) }));
}

export function removeRuns(ids: ReadonlySet<string>): void {
  tunerSection.set((s) => ({ ...s, runs: s.runs.filter((r) => !ids.has(r.id)) }));
}

export function nextRunNumber(): number {
  return tunerSection.get().runs.reduce((m, r) => Math.max(m, r.n), 0) + 1;
}

export function setLoopConfig(uid48: string, loopKey: string, cfg: LoopConfig): void {
  tunerSection.set((s) => ({ ...s, configs: { ...s.configs, [loopId(uid48, loopKey)]: cfg } }));
}

export function storeGainSet(uid48: string, loopKey: string, set: GainSetId, gains: Gains | null, makeActive = false): void {
  const id = loopId(uid48, loopKey);
  tunerSection.set((s) => {
    const prev = s.sets[id] ?? { A: null, B: null, active: 'A' as GainSetId };
    return { ...s, sets: { ...s.sets, [id]: { ...prev, [set]: gains, active: makeActive ? set : prev.active } } };
  });
}

export function setActiveSet(uid48: string, loopKey: string, set: GainSetId): void {
  const id = loopId(uid48, loopKey);
  tunerSection.set((s) => {
    const prev = s.sets[id] ?? { A: null, B: null, active: 'A' as GainSetId };
    return { ...s, sets: { ...s.sets, [id]: { ...prev, active: set } } };
  });
}

export function setNotes(notes: string): void {
  tunerSection.set((s) => ({ ...s, notes }));
}
