import { toast } from '../../ui';
import { t } from '../../i18n';
import { useProject, setProjectSection } from './store';

export interface ProjectSection<T> {
  readonly id: string;
  /** Schema version written with the data. */
  readonly version: number;
  /** Current value (the `initial` value when absent or invalid). */
  get(): T;
  set(value: T | ((prev: T) => T)): void;
  clear(): void;
  /** React hook; re-renders when this section changes. */
  use(): T;
}

export interface ProjectSectionOptions<T> {
  /** Value when the section is absent, damaged or from an unknown future version. */
  initial: T;
  /**
   * Required shape check of the (migrated) data. Must not throw; if it does, the data counts as
   * invalid. Invalid data reads as `initial` and the user is told once; the raw data stays in the
   * file until the section is written again.
   */
  validate: (v: unknown) => v is T;
  /**
   * Current schema version (integer ≥ 1, default 1). Bump it whenever the stored shape changes
   * incompatibly, and teach `migrate` the old shape.
   */
  version?: number;
  /**
   * Upgrades data stored with an older version (`from` < `version`) to the current shape. Return
   * `undefined` to give up (reads as `initial`, user notified). Required once `version` > 1.
   */
  migrate?: (raw: unknown, from: number) => unknown;
}

/** @deprecated use `validate`; kept so existing sections keep compiling. */
type LegacyOptions<T> = Omit<ProjectSectionOptions<T>, 'validate'> & { guard: (v: unknown) => v is T };

const registered = new Set<string>();
const SECTION_ID = /^[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9]+)*$/;

// Raw values already reported as damaged (identity: a new file or a new write is a new object).
const reported = new WeakSet<object>();
const reportedPrimitive = new Map<string, unknown>();

function notifyInvalid(id: string, raw: unknown, why: 'invalid' | 'newer' | 'migrate'): void {
  if (typeof raw === 'object' && raw !== null) {
    if (reported.has(raw)) return;
    reported.add(raw);
  } else {
    if (reportedPrimitive.get(id) === raw) return;
    reportedPrimitive.set(id, raw);
  }
  console.warn(`[project] section "${id}" ${why}; using defaults`);
  // Deferred: reads happen during render, toasts must not update another store mid-render.
  queueMicrotask(() =>
    toast.warn(t('core.project.sectionInvalid', { id }), { id: `project.section.${id}`, description: t(`core.project.sectionWhy.${why}`) }),
  );
}

/** Pure reader, exported for tests: raw stored value + its version → value for the screen. */
export function readSection<T>(id: string, opts: ProjectSectionOptions<T>, raw: unknown, storedVersion: number | undefined, notify = true): T {
  if (raw === undefined) return opts.initial;
  const version = opts.version ?? 1;
  const from = storedVersion ?? 1;
  let data: unknown = raw;
  try {
    if (from > version) {
      if (notify) notifyInvalid(id, raw, 'newer');
      return opts.initial;
    }
    if (from < version) {
      data = opts.migrate ? opts.migrate(raw, from) : undefined;
      if (data === undefined) {
        if (notify) notifyInvalid(id, raw, 'migrate');
        return opts.initial;
      }
    }
    if (opts.validate(data)) return data;
  } catch (e) {
    console.error(`[project] section "${id}" validate/migrate threw`, e);
  }
  if (notify) notifyInvalid(id, raw, 'invalid');
  return opts.initial;
}

/**
 * Typed, feature-owned slice of the project file. Define once at module level in the feature:
 * ```ts
 * export const tunerRuns = defineProjectSection('tuner.runs', { initial: [] as TunerRun[], validate: isRunList });
 * tunerRuns.set((runs) => [...runs, run]);   const runs = tunerRuns.use();
 * ```
 * Data from hand-edited, damaged or older files never reaches the screen unchecked: it is migrated
 * (`version` / `migrate`) and validated; anything invalid reads as `initial` with a one-time toast.
 */
export function defineProjectSection<T>(id: string, options: ProjectSectionOptions<T> | LegacyOptions<T>): ProjectSection<T> {
  const opts: ProjectSectionOptions<T> = 'validate' in options ? options : { ...options, validate: options.guard };
  const version = opts.version ?? 1;
  if (!Number.isInteger(version) || version < 1) throw new Error(`[project] section "${id}": version must be an integer ≥ 1`);
  if (version > 1 && !opts.migrate) throw new Error(`[project] section "${id}": version ${version} needs migrate()`);
  if (!SECTION_ID.test(id) && import.meta.env?.DEV) console.warn(`[project] section id "${id}" should look like "<screen>.<name>"`);
  if (registered.has(id) && import.meta.env?.DEV) console.warn(`[project] section "${id}" defined twice`);
  registered.add(id);

  // Memoised per raw value: validation can be costly and `use()` runs on every render.
  let lastRaw: unknown = Symbol('none');
  let lastVer: number | undefined;
  let lastVal: T = opts.initial;
  const read = (raw: unknown, storedVersion: number | undefined): T => {
    if (raw === lastRaw && storedVersion === lastVer) return lastVal;
    lastVal = readSection(id, opts, raw, storedVersion);
    lastRaw = raw;
    lastVer = storedVersion;
    return lastVal;
  };
  const current = (): T => {
    const p = useProject.getState().project;
    return read(p.sections[id], p.sectionVersions?.[id]);
  };
  return {
    id,
    version,
    get: current,
    set: (value) => {
      const prev = current();
      const next = typeof value === 'function' ? (value as (p: T) => T)(prev) : value;
      setProjectSection(id, next, version);
    },
    clear: () => setProjectSection(id, undefined),
    use: () => {
      const raw = useProject((s) => s.project.sections[id]);
      const ver = useProject((s) => s.project.sectionVersions?.[id]);
      return read(raw, ver);
    },
  };
}
