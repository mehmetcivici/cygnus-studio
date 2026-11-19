import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { DeviceState, paramByKey, type ControlStopReason, type GainRole } from '@cygnus/protocol';
import {
  describeError,
  displayName,
  useConnection,
  useDevices,
  useDrive,
  useDriveSession,
  useSelectedDevice,
  type DeviceView,
  type DriveSession,
} from '../../core';
import { toast } from '../../ui';
import { useI18n } from '../../i18n';
import {
  TestAborted,
  TunerDriver,
  closedProgram,
  ffProgram,
  identStepProgram,
  relayProgram,
  type ProgramKind,
  type TestProgram,
} from './engine';
import { defaultLimits, loopContext, roundNice, targetBlock, type LoopContext, type TestLimits } from './loop';
import { defaultSignal, signalDuration, signalExtent, type SignalConfig } from './signals';
import { addRun, nextRunNumber, setActiveSet, setLoopConfig, storeGainSet, tunerSection } from './project';
import { makeRun } from './runs';
import { baseline, popHistory, pushHistory, sameGains, setBaseline, setUi, useLoopGains, useParamValues, useTunerUi } from './state';
import { forModel, loopId, type GainSetId, type GainSets, type Gains, type LoopConfig, type TunerRun } from './types';
import { tTuner } from './messages';

const DRIVER_ENV = {
  now: () => performance.now(),
  setTimeout: (fn: () => void, ms: number): unknown => window.setTimeout(fn, ms),
  clearTimeout: (h: unknown): void => window.clearTimeout(h as number),
};

/** Boards the tuner can work with: catalog loops, streaming and control. */
export function isTunable(d: DeviceView): boolean {
  return !!d.def && d.def.tuner.loops.length > 0 && d.handle.capabilities.stream && d.handle.capabilities.control && !d.legacy;
}

export type DeviceProblem = 'offline' | 'estop' | 'fault' | null;

export interface RelaySettings {
  amplitude: number;
  hysteresis: number;
  cycles: number;
  centre: number;
}

export interface TunerApi {
  view: DeviceView;
  ctx: LoopContext;
  id: string;
  driver: TunerDriver | null;
  streamError: string | null;
  session: DriveSession | null;
  armed: boolean;
  busyOwner: string | null;
  problem: DeviceProblem;
  gains: Gains;
  gainsLoaded: boolean;
  sets: GainSets;
  config: LoopConfig;
  setConfig: (patch: Partial<LoopConfig>) => void;
  setSignal: (patch: Partial<SignalConfig>) => void;
  setLimits: (patch: Partial<TestLimits>) => void;
  integrating: boolean;
  runs: TunerRun[];
  currentLimit: number | undefined;
  testing: boolean;
  /** Why the configured test may not start (null = ok). */
  signalBlock: 'mode' | 'amplitude' | 'range' | 'duration' | null;
  writeGains: (next: Gains, opts?: { history?: boolean }) => Promise<void>;
  undo: () => Promise<void>;
  revert: () => Promise<void>;
  save: () => Promise<void>;
  switchSet: (set: GainSetId) => Promise<void>;
  storeInSet: (set: GainSetId, g: Gains) => void;
  runClosed: (signal?: SignalConfig) => Promise<TunerRun | null>;
  runAB: () => Promise<void>;
  runFeedforward: () => Promise<TunerRun | null>;
  runIdent: () => Promise<TunerRun | null>;
  runRelay: (o: RelaySettings) => Promise<TunerRun | null>;
  stopTest: () => void;
  /** Target the armed loop holds between tests (manual mode drives it). */
  setHold: (v: number) => void;
}

const Ctx = createContext<TunerApi | null>(null);
export const TunerProvider = Ctx.Provider;

export function useTuner(): TunerApi {
  const v = useContext(Ctx);
  if (!v) throw new Error('useTuner outside TunerProvider');
  return v;
}

/** Picks the board: URL parameter, then the screen's last choice, the shell selection, the first match. */
export function useTunerDevice(paramUid: string | undefined): { view: DeviceView | undefined; tunable: DeviceView[] } {
  const devices = useDevices();
  const uid = useTunerUi((s) => s.uid);
  const [selected] = useSelectedDevice();
  const tunable = useMemo(() => devices.filter((d) => isTunable(d) && !d.unassigned && !d.conflict), [devices]);
  const pick =
    tunable.find((d) => d.uid48 === paramUid) ??
    tunable.find((d) => d.uid48 === uid) ??
    (selected && isTunable(selected) ? selected : undefined) ??
    tunable.find((d) => d.online);
  return { view: pick, tunable };
}

function problemOf(v: DeviceView): DeviceProblem {
  if (!v.online) return 'offline';
  if (v.state === DeviceState.ESTOP) return 'estop';
  if (v.status === 'fault') return 'fault';
  return null;
}

/**
 * First step for a self-regulating loop: a tenth of the test limit (a beginner who arms and
 * presses Enter must not throw a 50 A step at a gravity-loaded arm). The test tab shows it.
 */
export const FIRST_STEP_FRACTION = 0.1;
export function firstStepSize(maxAmplitude: number): number {
  return roundNice(maxAmplitude * FIRST_STEP_FRACTION);
}

export function defaultConfig(ctx: LoopContext, centre: number): LoopConfig {
  const limits = defaultLimits(ctx, ctx.integrating ? centre : 0);
  const span = ctx.integrating ? roundNice((limits.rangeMax - limits.rangeMin) * 0.3) : firstStepSize(limits.maxAmplitude);
  const from = ctx.integrating ? Number(centre.toFixed(ctx.digits)) : 0;
  // Self-regulating loops settle on the process time constant: give them a longer hold.
  const signal = { ...defaultSignal('step', span, from), hold: ctx.integrating ? 2 : 3, pre: ctx.integrating ? 1 : 0.5 };
  if (!ctx.integrating) {
    signal.offset = span;
    signal.amplitude = span / 4;
  }
  return { signal, limits };
}

/** Plain-language group of the host's stop reason. */
export function haltGroup(reason: ControlStopReason | null): 'estop' | 'restart' | 'fault' | 'number' | 'lost' | 'other' {
  switch (reason) {
    case 'estop':
    case 'boardEstop':
      return 'estop';
    case 'boardReset':
    case 'bootloader':
      return 'restart';
    case 'boardFault':
    case 'disabled':
      return 'fault';
    case 'renumbered':
    case 'unresolved':
      return 'number';
    case 'lost':
    case 'disconnected':
      return 'lost';
    default:
      return 'other';
  }
}

/** Builds the screen's API for one board + loop. */
export function useTunerController(view: DeviceView, loopKey: string): TunerApi {
  const { lang } = useI18n();
  const def = view.def!;
  const loop = def.tuner.loops.find((l) => l.key === loopKey) ?? def.tuner.loops[0]!;
  const ctx = useMemo(() => loopContext(def, loop), [def, loop]);
  const id = loopId(view.uid48, loop.key);
  const phase = useConnection((s) => s.phase);
  const online = view.online && phase === 'connected';

  // ---- stream + driver ---------------------------------------------------------------------
  const [driver, setDriver] = useState<TunerDriver | null>(null);
  const [streamError, setStreamError] = useState<string | null>(null);
  const handle = view.handle;
  useEffect(() => {
    if (!online) {
      setDriver(null);
      return;
    }
    const d = new TunerDriver(handle, ctx, DRIVER_ENV);
    try {
      d.open();
      setStreamError(null);
    } catch (e) {
      setStreamError(describeError(e, lang));
    }
    setDriver(d);
    return () => {
      d.close();
      setDriver(null);
    };
    // Language only affects the error text; reopening the stream for it is not wanted.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handle, ctx, online]);
  const testing = useSyncExternalStore(
    useCallback((cb: () => void) => (driver ? driver.subscribe(cb) : () => undefined), [driver]),
    () => driver?.testing ?? false,
  );

  // ---- drive session -------------------------------------------------------------------------
  const { session, armed, busyOwner } = useDriveSession('tuner', view.uid48);
  const driverRef = useRef(driver);
  driverRef.current = driver;
  useEffect(() => session?.onStop(() => driverRef.current?.release()), [session]);
  // The host ended the control session on its own (BOOT, E-STOP, fault, renumbering): never
  // keep the screen armed over a loop that no longer runs.
  useEffect(() => {
    if (!driver) return;
    return driver.onHalt((reason) => {
      toast.warn(tTuner('abort.board'), { id: 'tuner-abort', description: tTuner(`halt.${haltGroup(reason)}`) });
      if (session?.armed) session.disarm('deviceFault');
    });
  }, [driver, session]);

  // ---- persisted per-loop settings -----------------------------------------------------------
  const section = tunerSection.use();
  const measuredNow = driver?.value(ctx.idx.measured);
  const stored = forModel(section.configs[id], def.key);
  const config = useMemo<LoopConfig>(() => {
    const base = defaultConfig(ctx, Number.isFinite(measuredNow) ? (measuredNow ?? 0) : 0);
    return stored ? { ...base, ...stored, signal: { ...base.signal, ...stored.signal }, limits: { ...base.limits, ...stored.limits } } : base;
    // Defaults use the position at first sight only; later readings must not move them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx, stored, driver]);
  // Position defaults (range, step start) are centred on where the mechanism is: once the
  // first samples arrived, fix them in the project so later readings do not move them.
  useEffect(() => {
    if (stored || !driver || !ctx.integrating) return;
    const h = window.setTimeout(() => {
      const m = driver.value(ctx.idx.measured);
      if (Number.isFinite(m) && !forModel(tunerSection.get().configs[id], def.key)) setLoopConfig(view.uid48, loop.key, def.key, defaultConfig(ctx, m));
    }, 400);
    return () => window.clearTimeout(h);
  }, [stored, driver, ctx, id, view.uid48, loop.key]);
  const setConfig = useCallback((patch: Partial<LoopConfig>) => setLoopConfig(view.uid48, loop.key, def.key, { ...config, ...patch }), [config, view.uid48, def.key, loop.key]);
  const setSignal = useCallback((patch: Partial<SignalConfig>) => setConfig({ signal: { ...config.signal, ...patch } }), [config, setConfig]);
  const setLimits = useCallback((patch: Partial<TestLimits>) => setConfig({ limits: { ...config.limits, ...patch } }), [config, setConfig]);
  const integrating = config.integrating ?? ctx.integrating;
  const ctxEff = useMemo(() => (integrating === ctx.integrating ? ctx : { ...ctx, integrating }), [ctx, integrating]);
  const runs = useMemo(() => section.runs.filter((r) => r.uid48 === view.uid48 && r.modelKey === def.key && r.loopKey === loop.key), [section.runs, view.uid48, def.key, loop.key]);
  const sets: GainSets = forModel(section.sets[id], def.key) ?? { A: null, B: null, active: 'A' };

  // ---- gains --------------------------------------------------------------------------------
  const gains = useLoopGains(view.uid48, loop.gains);
  const gainsLoaded = ctx.roles.every((r) => gains[r] !== undefined);
  const limitKeys = useMemo(() => (ctx.currentLimitParam ? [ctx.currentLimitParam] : []), [ctx.currentLimitParam]);
  const limitVals = useParamValues(view.uid48, limitKeys);
  const currentLimit = ctx.currentLimitParam ? limitVals[ctx.currentLimitParam] : undefined;
  const unsaved = view.flags.unsaved;
  useEffect(() => {
    if (gainsLoaded && !baseline(id) && !unsaved) setBaseline(id, gains);
  }, [gainsLoaded, id, unsaved, gains]);
  // The active set follows the board while the user edits.
  useEffect(() => {
    if (!gainsLoaded) return;
    const cur = sets[sets.active];
    if (!cur || !sameGains(cur, gains)) storeGainSet(view.uid48, loop.key, def.key, sets.active, gains);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gains, gainsLoaded]);

  const gainsRef = useRef(gains);
  gainsRef.current = gains;
  const write = useCallback(
    async (next: Gains, history = true): Promise<void> => {
      const prev = gainsRef.current;
      if (history) pushHistory(id, prev);
      for (const [role, v] of Object.entries(next) as Array<[GainRole, number]>) {
        const key = loop.gains[role];
        if (!key || v === undefined || Object.is(prev[role], v)) continue;
        const p = paramByKey(def, key);
        const val = p ? Math.min(p.max, Math.max(p.min, v)) : v;
        try {
          await handle.setParam(key, val);
        } catch (e) {
          toast.error(`${key}: ${describeError(e, lang)}`);
          return;
        }
      }
    },
    [id, loop.gains, def, handle, lang],
  );

  // ---- tests --------------------------------------------------------------------------------
  const runTest = useCallback(
    async (program: TestProgram, kind: ProgramKind, duration: number, signal: SignalConfig | null, extra: { hysteresis?: number } = {}): Promise<TunerRun | null> => {
      const d = driverRef.current;
      if (!d || !session?.armed) {
        toast.warn(tTuner('needArm'), { id: 'tuner-arm' });
        return null;
      }
      setUi({ busy: { kind, startedAt: performance.now(), duration } });
      const gainsAt = { ...gainsRef.current };
      const set = forModel(tunerSection.get().sets[id], def.key)?.active ?? 'A';
      try {
        const cap = await d.runTest(program, config.limits);
        if (cap.t.length < 10) return null;
        const run = makeRun(
          cap,
          {
            ctx: ctxEff,
            uid48: view.uid48,
            deviceName: displayName(view, lang),
            gains: gainsAt,
            gainSet: set,
            signal,
            currentLimit,
            integrating,
            hysteresis: extra.hysteresis,
          },
          nextRunNumber(),
        );
        addRun(run);
        const ui = useTunerUi.getState();
        const prevFocus = ui.focus ? tunerSection.get().runs.find((r) => r.id === ui.focus) : undefined;
        const keepPrev = run.kind === 'closed' && prevFocus && prevFocus.kind === 'closed' && prevFocus.loopKey === run.loopKey && prevFocus.uid48 === run.uid48;
        const multi = ui.selected.length >= 2 ? ui.selected : keepPrev && prevFocus ? [prevFocus.id] : [];
        if (run.kind === 'closed') {
          setUi({
            focus: run.id,
            selected: [...multi.filter((x) => x !== run.id), run.id],
            view: run.analysis.bode ? 'bode' : 'compare',
            rightTab: run.analysis.bode ? 'freq' : 'metrics',
          });
        } else setUi({ focus: run.id });
        return run;
      } catch (e) {
        if (e instanceof TestAborted) {
          if (e.reason !== 'stopped' && e.reason !== 'board') toast.warn(tTuner(`abort.${e.reason}`), { id: 'tuner-abort' });
        } else toast.error(describeError(e, lang));
        return null;
      } finally {
        setUi({ busy: null });
      }
    },
    [session, config.limits, ctxEff, view, lang, currentLimit, integrating, id],
  );

  const sig = config.signal;
  const signalBlock = useMemo((): TunerApi['signalBlock'] => {
    if (sig.kind === 'manual') return null;
    const T = signalDuration(sig);
    if (!(T <= config.limits.maxDuration)) return 'duration';
    const [lo, hi] = signalExtent(sig);
    return targetBlock(ctxEff, config.limits, lo) ?? targetBlock(ctxEff, config.limits, hi);
  }, [sig, config.limits, ctxEff]);

  const runClosed = useCallback(
    (s: SignalConfig = sig) => {
      if (s.kind === 'manual') return Promise.resolve(null);
      return runTest(closedProgram(s, integrating ? undefined : 0), 'closed', signalDuration(s), s);
    },
    [sig, runTest, integrating],
  );

  const switchSet = useCallback(
    async (set: GainSetId) => {
      const cur = forModel(tunerSection.get().sets[id], def.key) ?? { A: null, B: null, active: 'A' as GainSetId };
      if (cur.active === set) return;
      // Leaving a set stores the board's gains into it; the other set (if any) is written.
      storeGainSet(view.uid48, loop.key, def.key, cur.active, gainsRef.current);
      const target = cur[set];
      setActiveSet(view.uid48, loop.key, def.key, set);
      if (target) await write(target, true);
      else storeGainSet(view.uid48, loop.key, def.key, set, gainsRef.current);
    },
    [id, view.uid48, def.key, loop.key, write],
  );

  const runAB = useCallback(async () => {
    const first = await (async () => {
      await switchSet('A');
      return runClosed();
    })();
    if (!first || !session?.armed) return;
    await switchSet('B');
    const second = await runClosed();
    if (second) setUi({ selected: [first.id, second.id], focus: second.id, view: 'compare' });
  }, [switchSet, runClosed, session]);

  const runFeedforward = useCallback(() => {
    const p = ffProgram({ maxOpen: config.limits.maxOpen, maxSpeed: config.limits.maxAmplitude, measured: ctx.idx.measured });
    return runTest(p, 'ff', p.maxDuration, null);
  }, [config.limits, ctx.idx.measured, runTest]);

  const runIdent = useCallback(() => {
    if (integrating || !ctx.openMode) {
      // Integrating processes run away open loop: identify from a closed-loop step instead.
      const s: SignalConfig = { ...sig, kind: 'step', repeats: 1 };
      return runTest(closedProgram(s, integrating ? undefined : 0), 'closed', signalDuration(s), s);
    }
    const p = identStepProgram({ step: Math.min(config.limits.maxOpen, Math.max(0.05, config.limits.maxOpen * 0.4)), maxSpeed: config.limits.maxAmplitude, measured: ctx.idx.measured });
    return runTest(p, 'ident', p.maxDuration, null);
  }, [integrating, ctx, sig, config.limits, runTest]);

  const runRelay = useCallback(
    (o: RelaySettings) => {
      const p = relayProgram({
        centre: o.centre,
        amplitude: o.amplitude,
        hysteresis: o.hysteresis,
        cycles: o.cycles,
        measured: ctx.idx.measured,
        duty: ctx.idx.duty,
        maxBias: Math.max(0, config.limits.maxOpen - o.amplitude),
        // A spinning mechanism comes back to rest; a positioned one stays where it was tested.
        rest: integrating ? o.centre : 0,
      });
      return runTest(p, 'relay', 1.2 + o.cycles * 0.5, null, { hysteresis: o.hysteresis });
    },
    [ctx.idx, config.limits.maxOpen, runTest, integrating],
  );

  // "Stop" means everything off: the test ends, the board gets its neutral command and the
  // screen disarms (review: the button used to leave the last open-loop duty running).
  const stopTest = useCallback(() => {
    driverRef.current?.abort('stopped');
    session?.disarm('released');
  }, [session]);

  // Armed: always start from the safe target (velocity/current: 0, position: where it is now),
  // never from what was held before the last stop.
  useEffect(() => {
    if (!armed || !driver) return;
    try {
      driver.hold(driver.safeTarget());
    } catch (e) {
      toast.error(describeError(e, lang));
      session?.disarm();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [armed, driver]);

  const setHold = useCallback(
    (v: number) => {
      const d = driverRef.current;
      if (!d || !session?.armed || d.testing) return;
      if (targetBlock(ctxEff, config.limits, v)) return;
      try {
        d.hold(v);
      } catch {
        // The loop was ended by the board; onHalt disarms the screen.
      }
    },
    [session, ctxEff, config.limits],
  );

  // Every stop path aborts a running test; also stop when the drive is cut elsewhere.
  const latched = useDrive((s) => s.estopLatched);
  useEffect(() => {
    if (latched) driverRef.current?.release();
  }, [latched]);
  // A board that reports E-STOP, a fault or goes offline ends the running test at once, even
  // before the core's session cut arrives.
  const problem = problemOf(view);
  useEffect(() => {
    if (problem) driverRef.current?.abort('board');
  }, [problem]);

  const undo = useCallback(async () => {
    const g = popHistory(id);
    if (g) await write(g, false);
  }, [id, write]);
  const revert = useCallback(async () => {
    const g = baseline(id);
    if (g) await write(g);
  }, [id, write]);
  const save = useCallback(async () => {
    try {
      await handle.save();
      setBaseline(id, gainsRef.current);
      toast.success(tTuner('gains.saved'));
    } catch (e) {
      toast.error(describeError(e, lang));
    }
  }, [handle, id, lang]);
  const storeInSet = useCallback((set: GainSetId, g: Gains) => storeGainSet(view.uid48, loop.key, def.key, set, { ...gainsRef.current, ...g }), [view.uid48, def.key, loop.key]);

  return {
    view,
    ctx: ctxEff,
    id,
    driver,
    streamError,
    session,
    armed,
    busyOwner,
    problem,
    gains,
    gainsLoaded,
    sets,
    config,
    setConfig,
    setSignal,
    setLimits,
    integrating,
    runs,
    currentLimit,
    testing,
    signalBlock,
    writeGains: (g, o) => write(g, o?.history ?? true),
    undo,
    revert,
    save,
    switchSet,
    storeInSet,
    runClosed,
    runAB,
    runFeedforward,
    runIdent,
    runRelay,
    stopTest,
    setHold,
  };
}
