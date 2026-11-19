import type { GainRole } from '@cygnus/protocol';
import type { ProgramKind } from './engine';
import type { SignalConfig, SignalKind } from './signals';
import type { TestLimits } from './loop';
import type { StepMetrics } from './analysis/step';
import type { FeedforwardFit } from './analysis/feedforward';
import type { FitResult } from './analysis/model';
import type { RelayResult } from './analysis/relay';
import type { Margins } from './analysis/bode';

export type Gains = Partial<Record<GainRole, number>>;
export type GainSetId = 'A' | 'B';

/** Recorded channels (seconds since the test start; decimated for the project file). */
export interface RunData {
  t: number[];
  target: number[];
  measured: number[];
  output: number[];
  error: number[];
  current: number[] | null;
}

export interface RunAnalysis {
  steps: StepMetrics[];
  ff?: FeedforwardFit;
  model?: FitResult;
  relay?: RelayResult;
  /** Frequency response of a sweep: plant estimate, loop with the run's gains, margins. */
  bode?: { f: number[]; plantDb: number[]; plantDeg: number[]; loopDb: number[]; loopDeg: number[]; closedDb: number[]; closedDeg: number[]; margins: Margins };
  /** Applied output per open-loop ratio seen in the run (e.g. supply voltage). */
  outputPerOpen?: number;
  /** Rate ceiling of the measurement when the run saturated (prediction slew limit). */
  slew?: number;
}

export interface TunerRun {
  id: string;
  /** Running number shown to the user (#1, #2 …). */
  n: number;
  createdAt: number;
  uid48: string;
  deviceName: string;
  modelKey: string;
  loopKey: string;
  unit: string;
  outputUnit: string;
  kind: ProgramKind;
  signal: SignalConfig | null;
  gains: Gains;
  gainSet: GainSetId | null;
  data: RunData;
  analysis: RunAnalysis;
  note: string;
  /** Stream facts for the report. */
  periodUs: number;
  lost: number;
}

export interface GainSets {
  A: Gains | null;
  B: Gains | null;
  active: GainSetId;
  /** Model the record belongs to: a uid48 alone may now name another card. Absent in older files. */
  modelKey?: string;
}

export interface LoopConfig {
  signal: SignalConfig;
  limits: TestLimits;
  /** User override of the process type. */
  integrating?: boolean;
  /** Model the record belongs to (see GainSets.modelKey). */
  modelKey?: string;
}

export interface TunerSection {
  version: 1;
  runs: TunerRun[];
  /** Keyed by `${uid48}:${loopKey}`. */
  sets: Record<string, GainSets>;
  configs: Record<string, LoopConfig>;
  notes: string;
}

export const EMPTY_SECTION: TunerSection = { version: 1, runs: [], sets: {}, configs: {}, notes: '' };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isNumArray(v: unknown): v is number[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'number' || x === null);
}

const isNum = (v: unknown): v is number => typeof v === 'number';
const isFiniteNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const RUN_KINDS: readonly string[] = ['closed', 'ff', 'ident', 'relay'] satisfies readonly ProgramKind[];
const SIGNAL_KIND_SET: readonly string[] = ['manual', 'step', 'square', 'sine', 'trapezoid', 'chirp'] satisfies readonly SignalKind[];
const SIGNAL_NUMS = ['from', 'to', 'pre', 'hold', 'offset', 'amplitude', 'period', 'freq', 'ramp', 'f0', 'f1', 'sweep', 'repeats'] as const;
const LIMIT_NUMS = ['maxAmplitude', 'rangeMin', 'rangeMax', 'maxDuration', 'maxOpen'] as const;
const ROLES: readonly string[] = ['kp', 'ki', 'kd', 'kS', 'kV', 'kA', 'iMax', 'outMax'] satisfies readonly GainRole[];
// Ids and units end up in the DOM, file names and reports: keep them short and plain.
const PLAIN = /^[\p{L}\p{N} _.:%°/·²³µΩ+-]{0,48}$/u;
const isPlain = (v: unknown): v is string => typeof v === 'string' && PLAIN.test(v);

function isGains(v: unknown): v is Gains {
  return isRecord(v) && Object.entries(v).every(([k, x]) => ROLES.includes(k) && isFiniteNum(x));
}

function isSignal(v: unknown): v is SignalConfig {
  return isRecord(v) && typeof v.kind === 'string' && SIGNAL_KIND_SET.includes(v.kind) && SIGNAL_NUMS.every((k) => isFiniteNum(v[k]));
}

function isLimits(v: unknown): v is TestLimits {
  return isRecord(v) && LIMIT_NUMS.every((k) => isFiniteNum(v[k]));
}

function isRun(v: unknown): v is TunerRun {
  if (!isRecord(v)) return false;
  const d = v.data;
  return (
    typeof v.id === 'string' &&
    v.id.length <= 64 &&
    isFiniteNum(v.n) &&
    isNum(v.createdAt) &&
    isPlain(v.uid48) &&
    typeof v.deviceName === 'string' &&
    typeof v.modelKey === 'string' &&
    isPlain(v.loopKey) &&
    isPlain(v.unit) &&
    isPlain(v.outputUnit) &&
    typeof v.kind === 'string' &&
    RUN_KINDS.includes(v.kind) &&
    (v.signal === null || isSignal(v.signal)) &&
    isGains(v.gains) &&
    (v.gainSet === null || v.gainSet === 'A' || v.gainSet === 'B') &&
    typeof v.note === 'string' &&
    isNum(v.periodUs) &&
    isNum(v.lost) &&
    isRecord(v.analysis) &&
    Array.isArray(v.analysis.steps) &&
    v.analysis.steps.every(isRecord) &&
    isRecord(d) &&
    isNumArray(d.t) &&
    isNumArray(d.target) &&
    isNumArray(d.measured) &&
    isNumArray(d.output) &&
    isNumArray(d.error) &&
    (d.current === null || isNumArray(d.current))
  );
}

function isGainSets(v: unknown): v is GainSets {
  return isRecord(v) && (v.A === null || isGains(v.A)) && (v.B === null || isGains(v.B)) && (v.active === 'A' || v.active === 'B') && (v.modelKey === undefined || isPlain(v.modelKey));
}

function isLoopConfig(v: unknown): v is LoopConfig {
  return isRecord(v) && isSignal(v.signal) && isLimits(v.limits) && (v.integrating === undefined || typeof v.integrating === 'boolean') && (v.modelKey === undefined || isPlain(v.modelKey));
}

/**
 * Shape check for the project section. Project files are shared between teams and may be
 * hand-edited or hostile: every field that reaches the board (gains, limits, signals) or the
 * page (labels, units, gain set names) is checked; anything else makes the section invalid
 * (the core then reads it as empty and tells the user).
 */
export function isTunerSection(v: unknown): v is TunerSection {
  if (!isRecord(v) || v.version !== 1) return false;
  return (
    Array.isArray(v.runs) &&
    v.runs.every(isRun) &&
    isRecord(v.sets) &&
    Object.values(v.sets).every(isGainSets) &&
    isRecord(v.configs) &&
    Object.values(v.configs).every(isLoopConfig) &&
    typeof v.notes === 'string'
  );
}

export const loopId = (uid48: string, loopKey: string): string => `${uid48}:${loopKey}`;

/**
 * A per-loop record only when it was made on this model: the uid48 in its key may now belong
 * to another card (another simulator scenario, a re-flashed board). Older records without a
 * model are taken as they are.
 */
export function forModel<T extends { modelKey?: string }>(rec: T | undefined, modelKey: string): T | undefined {
  return rec && (rec.modelKey === undefined || rec.modelKey === modelKey) ? rec : undefined;
}
