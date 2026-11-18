import type { GainRole } from '@cygnus/protocol';
import type { ProgramKind } from './engine';
import type { SignalConfig } from './signals';
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
}

export interface LoopConfig {
  signal: SignalConfig;
  limits: TestLimits;
  /** User override of the process type. */
  integrating?: boolean;
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

function isRun(v: unknown): v is TunerRun {
  if (!isRecord(v)) return false;
  const d = v.data;
  return (
    typeof v.id === 'string' &&
    typeof v.n === 'number' &&
    typeof v.uid48 === 'string' &&
    typeof v.loopKey === 'string' &&
    typeof v.kind === 'string' &&
    isRecord(v.gains) &&
    isRecord(v.analysis) &&
    Array.isArray((v.analysis as Record<string, unknown>).steps) &&
    isRecord(d) &&
    isNumArray(d.t) &&
    isNumArray(d.target) &&
    isNumArray(d.measured) &&
    isNumArray(d.output) &&
    isNumArray(d.error)
  );
}

/** Shape check for the project section (hand-edited or older files read as empty). */
export function isTunerSection(v: unknown): v is TunerSection {
  if (!isRecord(v) || v.version !== 1) return false;
  return Array.isArray(v.runs) && v.runs.every(isRun) && isRecord(v.sets) && isRecord(v.configs) && typeof v.notes === 'string';
}

export const loopId = (uid48: string, loopKey: string): string => `${uid48}:${loopKey}`;
