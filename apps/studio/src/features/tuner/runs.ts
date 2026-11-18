import type { Capture, ProgramKind } from './engine';
import type { LoopContext } from './loop';
import type { Gains, GainSetId, RunAnalysis, RunData, TunerRun } from './types';
import type { SignalConfig, SignalKind } from './signals';
import { detectSteps, stepMetrics } from './analysis/step';
import { fitFeedforward } from './analysis/feedforward';
import { identify, type FitResult, type ProcessModel } from './analysis/model';
import { analyzeRelay } from './analysis/relay';
import { estimateResponse, loopResponse, margins, toBode } from './analysis/bode';
import { slewFromRecord } from './analysis/predict';

/** Samples kept per run in the project file. */
export const RUN_POINTS = 1500;
const MAX_STEPS = 20;

export interface RunContext {
  ctx: LoopContext;
  uid48: string;
  deviceName: string;
  gains: Gains;
  gainSet: GainSetId | null;
  signal: SignalConfig | null;
  /** Value of the current limit parameter, if known. */
  currentLimit?: number;
  /** Process type used for identification. */
  integrating: boolean;
  /** Hysteresis the relay ran with (measured units). */
  hysteresis?: number;
}

/** Median of |output / ratio| where the open-loop ratio is clearly non-zero. */
function outputPerOpen(cap: Capture, ctx: LoopContext): number | undefined {
  const di = ctx.idx.duty;
  const oi = ctx.idx.output;
  if (di < 0 || oi < 0 || di === oi) return di === oi && di >= 0 ? 1 : undefined;
  const r: number[] = [];
  const d = cap.ch[di]!;
  const u = cap.ch[oi]!;
  for (let i = 0; i < d.length; i++) if (Math.abs(d[i]!) > 0.05 && Number.isFinite(u[i]!)) r.push(Math.abs(u[i]! / d[i]!));
  if (r.length < 10) return undefined;
  r.sort((a, b) => a - b);
  return r[r.length >> 1];
}

/** Model that the feed-forward fit implies: V = kS + kV·ω + kA·α ⇒ K = 1/kV, τ = kA/kV. */
export function modelFromFeedforward(ff: { kS: number; kV: number; kA: number }): ProcessModel | null {
  if (!(ff.kV > 0)) return null;
  return { kind: 'fopdt', K: 1 / ff.kV, tau: Math.max(1e-3, ff.kA / ff.kV), theta: 0, c: -ff.kS / ff.kV };
}

export function analyseCapture(cap: Capture, rc: RunContext): RunAnalysis {
  const { ctx } = rc;
  const I = ctx.idx;
  const t = cap.t;
  const target = cap.ch[I.target] ?? [];
  const y = cap.ch[I.measured] ?? [];
  const u = cap.ch[I.output] ?? [];
  const cur = I.current >= 0 ? cap.ch[I.current] : undefined;
  const a: RunAnalysis = { steps: [] };
  const opo = outputPerOpen(cap, ctx);
  if (opo !== undefined) a.outputPerOpen = opo;
  const outLimit = rc.gains.outMax !== undefined && rc.gains.outMax > 0 ? Math.min(rc.gains.outMax, opo ?? Infinity) : opo;

  if (cap.kind === 'closed') {
    // A sweep has no steps to grade (its lead-in move is not a test step).
    const edges = rc.signal?.kind === 'chirp' ? [] : detectSteps(t, target).slice(0, MAX_STEPS);
    a.steps = edges.map((e) =>
      stepMetrics(t, target, y, e, { output: u, outputLimit: outLimit, current: cur, currentLimit: rc.currentLimit }),
    );
    if (a.steps.some((m) => m.saturation > 10)) {
      const s = slewFromRecord(t, y);
      if (Number.isFinite(s) && s > 0) a.slew = s;
    }
    const sig = rc.signal;
    if (sig && sig.kind === 'chirp') {
      // Only the sweep itself: the lead-in carries the move to the offset, whose low-frequency
      // energy would leak into every band.
      const from = Math.max(0, t.findIndex((x) => x >= sig.pre));
      const sl = <T>(a: T[]): T[] => a.slice(from);
      const p = estimateResponse(sl(t), sl(u), sl(y), sig.f0, sig.f1, 36);
      const tcl = estimateResponse(sl(t), sl(target), sl(y), sig.f0, sig.f1, 36);
      const pb = toBode(p);
      const lb = toBode(loopResponse(p, rc.gains));
      const cb = toBode(tcl);
      // The closed-loop estimate shares the band layout of the plant estimate when both
      // bands survived; otherwise its own frequencies are close enough for display.
      a.bode = {
        f: Array.from(pb.f),
        plantDb: Array.from(pb.magDb),
        plantDeg: Array.from(pb.phaseDeg),
        loopDb: Array.from(lb.magDb),
        loopDeg: Array.from(lb.phaseDeg),
        closedDb: resampleTo(cb.f, cb.magDb, pb.f),
        closedDeg: resampleTo(cb.f, cb.phaseDeg, pb.f),
        margins: margins(lb),
      };
    }
  } else if (cap.kind === 'ff') {
    const ff = fitFeedforward(t, u, y, { current: cur, currentLimit: rc.currentLimit });
    if (ff) {
      a.ff = ff;
      const m = modelFromFeedforward(ff);
      if (m) a.model = { model: m, r2: ff.r2, rms: NaN };
    }
  } else if (cap.kind === 'ident') {
    const fit = identify(t, u, y, { kind: rc.integrating ? 'integrating' : 'fopdt' });
    if (fit) a.model = fit;
  } else if (cap.kind === 'relay') {
    // Only the open-loop (relay) part; the first periods carry the approach transient.
    const start = cap.cmd.findIndex((c) => Number.isFinite(c));
    if (start >= 0) {
      const sl = <T>(arr: T[]): T[] => arr.slice(start);
      const r = analyzeRelay(sl(t), sl(u), sl(y), { hysteresis: rc.hysteresis ?? 0, skip: 2 });
      if (r) a.relay = r;
      const fit = identify(sl(t), sl(u), sl(y), { kind: rc.integrating ? 'integrating' : 'fopdt' });
      if (fit) a.model = fit;
    }
  }
  return a;
}

function resampleTo(fx: Float64Array, v: Float64Array, to: Float64Array): number[] {
  const out: number[] = [];
  for (const f of to) {
    let best = -1;
    let bd = Infinity;
    for (let i = 0; i < fx.length; i++) {
      const d = Math.abs(Math.log(fx[i]! / f));
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    out.push(best >= 0 && bd < 0.2 ? v[best]! : NaN);
  }
  return out;
}

/**
 * Keeps ≤ max samples: a uniform stride plus the samples on both sides of every target change,
 * so step edges stay sharp in the stored copy.
 */
export function decimate(cap: Capture, ctx: LoopContext, max = RUN_POINTS): RunData {
  const n = cap.t.length;
  const I = ctx.idx;
  const keep: number[] = [];
  const stride = Math.max(1, Math.ceil(n / max));
  const target = cap.ch[I.target] ?? [];
  let lastKept = -1;
  for (let i = 0; i < n; i++) {
    const edge = i > 0 && target[i] !== target[i - 1] && Math.abs((target[i] ?? 0) - (target[i - 1] ?? 0)) > 0;
    if (i % stride === 0 || edge || i === n - 1) {
      if (edge && i - 1 > lastKept) keep.push(i - 1);
      keep.push(i);
      lastKept = i;
    }
  }
  // Ramps change the target on every sample; fall back to the stride then.
  const idx = keep.length > max * 1.5 ? keep.filter((i) => i % stride === 0 || i === n - 1) : keep;
  const pick = (a: number[] | undefined): number[] => (a ? idx.map((i) => round(a[i]!)) : []);
  return {
    t: idx.map((i) => Math.round(cap.t[i]! * 1e5) / 1e5),
    target: pick(cap.ch[I.target]),
    measured: pick(cap.ch[I.measured]),
    output: pick(cap.ch[I.output]),
    error: pick(cap.ch[I.error]),
    current: I.current >= 0 ? pick(cap.ch[I.current]) : null,
  };
}

/** Float32 stream values do not need more than 7 significant digits in the file. */
function round(v: number): number {
  if (!Number.isFinite(v)) return v;
  return Number(v.toPrecision(7));
}

export function makeRun(cap: Capture, rc: RunContext, n: number): TunerRun {
  return {
    id: `r${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`,
    n,
    createdAt: Date.now(),
    uid48: rc.uid48,
    deviceName: rc.deviceName,
    modelKey: rc.ctx.def.key,
    loopKey: rc.ctx.loop.key,
    unit: rc.ctx.unit,
    outputUnit: rc.ctx.outputUnit,
    kind: cap.kind,
    signal: rc.signal,
    gains: rc.gains,
    gainSet: rc.gainSet,
    data: decimate(cap, rc.ctx),
    analysis: analyseCapture(cap, rc),
    note: '',
    periodUs: cap.periodUs,
    lost: cap.lost,
  };
}

/** Translation key of a run's short label: the generator for closed-loop runs. */
export function runLabelKey(run: TunerRun): `gen.k.${SignalKind}` | `kind.${ProgramKind}` {
  return run.kind === 'closed' && run.signal ? `gen.k.${run.signal.kind}` : `kind.${run.kind}`;
}

/** First step's metrics (the headline numbers of a run). */
export function headline(run: TunerRun) {
  return run.analysis.steps[0] ?? null;
}

/** Best model available for a loop: newest identification, relay or feed-forward fit. */
export function latestModel(runs: readonly TunerRun[]): { run: TunerRun; fit: FitResult } | null {
  for (let i = runs.length - 1; i >= 0; i--) {
    const r = runs[i]!;
    if (r.analysis.model) return { run: r, fit: r.analysis.model };
  }
  return null;
}

// ---- export ----------------------------------------------------------------------------------

export function runsToCsv(runs: readonly TunerRun[], decimalComma = false): string {
  const sep = decimalComma ? ';' : ',';
  const num = (v: number | undefined): string => {
    if (v === undefined || !Number.isFinite(v)) return '';
    const s = String(v);
    return decimalComma ? s.replace('.', ',') : s;
  };
  const lines = [['run', 'kind', 'loop', 't_s', 'target', 'measured', 'output', 'error', 'current'].join(sep)];
  for (const r of runs) {
    const d = r.data;
    for (let i = 0; i < d.t.length; i++) {
      lines.push(
        [r.n, r.kind, r.loopKey, num(d.t[i]), num(d.target[i]), num(d.measured[i]), num(d.output[i]), num(d.error[i]), num(d.current?.[i])].join(sep),
      );
    }
  }
  return lines.join('\n');
}

export function runsToJson(runs: readonly TunerRun[]): string {
  return JSON.stringify({ format: 'cygnus-tuner-runs', version: 1, runs }, null, 1);
}
