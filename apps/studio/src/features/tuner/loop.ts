import { paramByKey, signalByKey, type GainRole, type ModelDef, type ParamDef, type TunerLoopDef } from '@cygnus/protocol';

/** Everything the tuner needs to know about one catalog loop, resolved once. */
export interface LoopContext {
  def: ModelDef;
  loop: TunerLoopDef;
  /** Control mode that runs the loop (CTRL `set` mode key) and its target range. */
  modeKey: string;
  modeMin: number;
  modeMax: number;
  /**
   * Open-loop mode of the same control frame (catalog `TunerLoopDef.openMode`), used by the
   * feed-forward, identification and relay experiments. Its `measured` signal reports the
   * applied ratio. Null: the loop offers no open-loop experiment.
   */
  openMode: { key: string; min: number; max: number; measured: string | undefined } | null;
  /** Stream channel keys, in stream order (duplicates removed). */
  streamKeys: string[];
  /** Index of each logical channel in `streamKeys` (−1 when absent). */
  idx: { target: number; measured: number; output: number; error: number; current: number; duty: number };
  /** Signal keys of the logical channels that are not part of the loop definition. */
  currentKey: string | undefined;
  /** Parameter that limits the current signal (for saturation and feed-forward exclusion). */
  currentLimitParam: string | undefined;
  /** Units: target/measured, loop output, current. */
  unit: string;
  outputUnit: string;
  currentUnit: string;
  /** Integrating process (catalog `TunerLoopDef.integrating`); the screen lets the user override it. */
  integrating: boolean;
  /** Gains present in the catalog for this loop, in display order. */
  roles: GainRole[];
  /** Stream period actually requested, µs (catalog minimum, at most 1 kHz). */
  periodUs: number;
  /** Display range of the measured signal. */
  range: [number, number];
  digits: number;
}

export const ROLE_ORDER: readonly GainRole[] = ['kp', 'ki', 'kd', 'kS', 'kV', 'kA', 'iMax', 'outMax'];

/** Symbol shown for a gain everywhere (panels, run summary, report). */
export const ROLE_SYMBOL: Record<GainRole, string> = { kp: 'Kp', ki: 'Ki', kd: 'Kd', kS: 'kS', kV: 'kV', kA: 'kA', iMax: 'Imax', outMax: 'Omax' };

/** Loops whose loop output feeds another loop's target (cascade), by unit match. */
export function cascadeOf(def: ModelDef): Array<{ outer: string; inner: string }> {
  const out: Array<{ outer: string; inner: string }> = [];
  for (const a of def.tuner.loops) {
    const outUnit = signalByKey(def, a.signals.output)?.unit ?? '';
    for (const b of def.tuner.loops) if (b !== a && outUnit !== '' && b.unit === outUnit) out.push({ outer: a.key, inner: b.key });
  }
  return out;
}

export function loopContext(def: ModelDef, loop: TunerLoopDef): LoopContext {
  const frame = def.controls.find((c) => c.index === loop.ctrlFrame && c.format === 'set') ?? def.controls.find((c) => c.format === 'set');
  const mode = frame?.modes?.find((m) => m.value === loop.mode);
  const open = loop.openMode ? frame?.modes?.find((m) => m.key === loop.openMode) : undefined;
  // Current signal: the measured signal of a loop in amperes, else the first A signal that is
  // not a supply (bus.*) reading.
  const ampLoop = def.tuner.loops.find((l) => l.unit === 'A');
  const currentKey =
    ampLoop?.signals.measured ??
    def.signals.find((s) => s.unit === 'A' && !s.key.startsWith('bus.'))?.key ??
    def.signals.find((s) => s.unit === 'A')?.key;
  const currentLimitParam =
    ampLoop?.extraParams?.find((k) => paramByKey(def, k)?.unit === 'A') ??
    def.params.find((p) => p.unit === 'A' && /current/.test(p.key) && /limit/.test(p.key) && !/supply/.test(p.key))?.key;
  const keys: string[] = [];
  const add = (k: string | undefined): number => {
    if (!k || !signalByKey(def, k)) return -1;
    const i = keys.indexOf(k);
    if (i >= 0) return i;
    keys.push(k);
    return keys.length - 1;
  };
  const idx = {
    target: add(loop.signals.target),
    measured: add(loop.signals.measured),
    output: add(loop.signals.output),
    error: add(loop.signals.error),
    current: add(currentKey),
    duty: add(open?.measured),
  };
  const measured = signalByKey(def, loop.signals.measured);
  const roles = ROLE_ORDER.filter((r) => loop.gains[r] !== undefined);
  return {
    def,
    loop,
    modeKey: mode?.key ?? loop.key,
    modeMin: mode?.min ?? -Infinity,
    modeMax: mode?.max ?? Infinity,
    openMode: open ? { key: open.key, min: open.min, max: open.max, measured: open.measured } : null,
    streamKeys: keys,
    idx,
    currentKey,
    currentLimitParam,
    unit: loop.unit,
    outputUnit: signalByKey(def, loop.signals.output)?.unit ?? '',
    currentUnit: currentKey ? (signalByKey(def, currentKey)?.unit ?? 'A') : 'A',
    integrating: loop.integrating === true,
    roles,
    periodUs: Math.max(def.stream.minPeriodUs, 1000),
    range: measured?.range ?? [-1, 1],
    digits: Math.min(4, Math.max(0, measured?.digits ?? 2)),
  };
}

export function gainParam(ctx: LoopContext, role: GainRole): ParamDef | undefined {
  const key = ctx.loop.gains[role];
  return key ? paramByKey(ctx.def, key) : undefined;
}

/** Default test limits for a loop. */
export interface TestLimits {
  /** Largest |target| for non-integrating loops. */
  maxAmplitude: number;
  /** Allowed target/measurement range for integrating loops. */
  rangeMin: number;
  rangeMax: number;
  /** Longest test, s. */
  maxDuration: number;
  /** Largest open-loop command (ratio of the open mode's range). */
  maxOpen: number;
}

export function defaultLimits(ctx: LoopContext, centre = 0): TestLimits {
  const span = ctx.range[1] - ctx.range[0];
  const half = span / 40;
  const modeAbs = Math.min(Math.abs(ctx.modeMax), Math.abs(ctx.modeMin));
  return {
    maxAmplitude: Number.isFinite(modeAbs) ? roundNice(modeAbs * 0.5) : roundNice(span / 4),
    rangeMin: centre - half,
    rangeMax: centre + half,
    maxDuration: 30,
    maxOpen: ctx.openMode ? Math.min(ctx.openMode.max, 0.5) : 0,
  };
}

/** Rounds to 1, 2 or 5 × 10ⁿ (for friendly defaults). */
export function roundNice(v: number): number {
  if (!(v > 0)) return v;
  const e = Math.floor(Math.log10(v));
  const f = v / 10 ** e;
  const m = f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10;
  return m * 10 ** e;
}

/** Why a target may not be sent (null = allowed). */
export function targetBlock(ctx: LoopContext, lim: TestLimits, v: number): 'mode' | 'amplitude' | 'range' | null {
  if (!Number.isFinite(v) || v < ctx.modeMin || v > ctx.modeMax) return 'mode';
  if (ctx.integrating) return v < lim.rangeMin - 1e-9 || v > lim.rangeMax + 1e-9 ? 'range' : null;
  return Math.abs(v) > lim.maxAmplitude + 1e-9 ? 'amplitude' : null;
}
