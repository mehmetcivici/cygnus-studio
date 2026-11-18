import { useProject, setProjectSection } from './store';

export interface ProjectSection<T> {
  readonly id: string;
  /** Current value (the `initial` value when absent or invalid). */
  get(): T;
  set(value: T | ((prev: T) => T)): void;
  clear(): void;
  /** React hook; re-renders when this section changes. */
  use(): T;
}

const registered = new Set<string>();

/**
 * Typed, feature-owned slice of the project file. Define once at module level in the feature:
 * ```ts
 * export const tunerRuns = defineProjectSection('tuner.runs', { initial: [] as TunerRun[], guard: isRunList });
 * tunerRuns.set((runs) => [...runs, run]);   const runs = tunerRuns.use();
 * ```
 * `guard` protects against hand-edited or older files; invalid data reads as `initial`.
 */
export function defineProjectSection<T>(id: string, opts: { initial: T; guard: (v: unknown) => v is T }): ProjectSection<T> {
  if (registered.has(id) && import.meta.env?.DEV) console.warn(`[project] section "${id}" defined twice`);
  registered.add(id);
  const read = (raw: unknown): T => (raw !== undefined && opts.guard(raw) ? raw : opts.initial);
  return {
    id,
    get: () => read(useProject.getState().project.sections[id]),
    set: (value) => {
      const prev = read(useProject.getState().project.sections[id]);
      const next = typeof value === 'function' ? (value as (p: T) => T)(prev) : value;
      setProjectSection(id, next);
    },
    clear: () => setProjectSection(id, undefined),
    use: () => read(useProject((s) => s.project.sections[id])),
  };
}
