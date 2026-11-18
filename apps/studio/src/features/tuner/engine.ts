import type { ControlLoop, ControlStopReason, DeviceHandle, StreamSubscription } from '@cygnus/protocol';
import { SeriesBuffer } from '../../ui';
import { signalDuration, signalValue, type SignalConfig } from './signals';
import { targetBlock, type LoopContext, type TestLimits } from './loop';

/** What a test asks the board for at one instant. */
export interface Command {
  /** `closed`: the loop's own mode (value = target); `open`: the open-loop mode (value = ratio). */
  mode: 'closed' | 'open';
  value: number;
}

export type ProgramKind = 'closed' | 'ff' | 'ident' | 'relay';

/**
 * A test is a small state machine fed with every stream sample. Time is the board's stream
 * clock (s since the first sample of the test), so host jitter never distorts the profile.
 */
export interface TestProgram {
  kind: ProgramKind;
  /** Hard stop, s (the test limit). */
  maxDuration: number;
  /** Command for time t given the newest sample, or null when the test is complete. */
  next(t: number, v: Float32Array): Command | null;
  /** What to hold once the test completes (null: stop driving). */
  after(v: Float32Array): Command | null;
}

export interface Capture {
  kind: ProgramKind;
  /** Seconds since the first sample of the test (board clock). */
  t: number[];
  /** One array per stream key, in `ctx.streamKeys` order. */
  ch: number[][];
  /** Open-loop command actually sent (NaN while closed loop). */
  cmd: number[];
  lost: number;
  periodUs: number;
}

/**
 * `stopped`: the user or the drive session ended it. `board`: the board/host ended the control
 * session (BOOT, E-STOP, fault, renumbering). `error`: the program itself threw.
 */
export type AbortReason = 'stopped' | 'limit' | 'range' | 'stream' | 'rejected' | 'board' | 'error';

export class TestAborted extends Error {
  constructor(readonly reason: AbortReason) {
    super(`test aborted: ${reason}`);
  }
}

export interface DriverEnv {
  /** Monotonic host clock, ms (stream stall watchdog). */
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const LIVE_CAPACITY = 120_000;
const CONTROL_RATE_HZ = 200;

interface ActiveTest {
  program: TestProgram;
  cap: Capture;
  t0: number;
  lastSampleAt: number;
  lost0: number;
  resolve: (c: Capture) => void;
  reject: (e: TestAborted) => void;
  watchdog: unknown;
  mode: 'closed' | 'open' | null;
  lastValue: number;
  /** Recording starts once the board reports the first command (stale hold values excluded). */
  synced: boolean;
}

/**
 * Owns the stream and the control loop for one board + loop. React never sees samples: they go
 * to `SeriesBuffer`s for the live charts and to the running test.
 *
 * The driver only commands the board while the screen says it is armed (`hold`/`runTest` are
 * called from armed state, `release()` on every stop); the drive session in core decides that.
 */
export class TunerDriver {
  /** Live buffers, seconds on the board clock. Index like `ctx.streamKeys`. */
  readonly live: SeriesBuffer[];
  private sub: StreamSubscription | null = null;
  private offData: (() => void) | null = null;
  private loop: ControlLoop | null = null;
  private loopMode: 'closed' | 'open' | null = null;
  private test: ActiveTest | null = null;
  private latest: Float32Array;
  private latestT = NaN;
  private origin = NaN;
  private listeners = new Set<() => void>();
  private limits: TestLimits | null = null;
  private offStopped: (() => void) | null = null;
  private haltListeners = new Set<(reason: ControlStopReason | null) => void>();
  holdTarget = 0;

  constructor(
    readonly device: DeviceHandle,
    readonly ctx: LoopContext,
    private readonly env: DriverEnv,
  ) {
    this.live = ctx.streamKeys.map(() => new SeriesBuffer(LIVE_CAPACITY));
    this.latest = new Float32Array(ctx.streamKeys.length).fill(NaN);
  }

  get streaming(): boolean {
    return this.sub !== null && !this.sub.closed;
  }

  get periodUs(): number {
    return this.sub?.periodUs ?? this.ctx.periodUs;
  }

  get lost(): number {
    return this.sub?.lost ?? 0;
  }

  get testing(): boolean {
    return this.test !== null;
  }

  get driving(): boolean {
    return this.loop !== null && this.loop.active;
  }

  /** Newest value of a stream channel (NaN until seen). */
  value(index: number): number {
    return index >= 0 ? (this.latest[index] ?? NaN) : NaN;
  }

  /** Board time of the newest sample, s since the stream opened. */
  get now(): number {
    return this.latestT;
  }

  /** Notified when testing/driving state changes. */
  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emit(): void {
    for (const cb of this.listeners) cb();
  }

  /**
   * Notified when the board side ended the control session on its own (the host stopped the
   * loop: BOOT, E-STOP, fault, renumbering). The screen must disarm: the driver never restarts
   * a loop it did not stop itself.
   */
  onHalt(cb: (reason: ControlStopReason | null) => void): () => void {
    this.haltListeners.add(cb);
    return () => this.haltListeners.delete(cb);
  }

  open(): void {
    if (this.sub) return;
    this.sub = this.device.stream.open({ signals: this.ctx.streamKeys, periodUs: this.ctx.periodUs });
    this.offData = this.sub.onData((tMs, v) => this.onSample(tMs / 1000, v));
  }

  close(): void {
    this.endTest('stopped');
    // A driver that goes away (board/loop switch, unmount) never leaves its loop running.
    this.dropLoop(true);
    this.offData?.();
    this.offData = null;
    this.sub?.close();
    this.sub = null;
  }

  private onSample(tAbs: number, v: Float32Array): void {
    // Live charts count seconds from the first sample, not from the host epoch.
    if (Number.isNaN(this.origin)) this.origin = tAbs;
    const t = tAbs - this.origin;
    this.latest.set(v);
    this.latestT = t;
    for (let i = 0; i < v.length; i++) this.live[i]?.push(t, v[i]!);
    const a = this.test;
    if (!a) return;
    try {
      this.feed(a, t, v);
    } catch (e) {
      // A throwing program must not leave the last command running.
      this.abort(e instanceof TestAborted ? e.reason : 'error');
    }
  }

  // ---- driving -------------------------------------------------------------------------------

  /** Holds a closed-loop target (starts the control session if needed). Armed state only. */
  hold(target: number): void {
    this.holdTarget = target;
    if (this.test) return;
    this.command({ mode: 'closed', value: target });
  }

  /**
   * The target that moves nothing: zero for a self-regulating loop (speed, current), the
   * present position for an integrating one.
   */
  safeTarget(): number {
    if (!this.ctx.integrating) return 0;
    const m = this.value(this.ctx.idx.measured);
    return Number.isFinite(m) ? Number(m.toFixed(6)) : this.holdTarget;
  }

  /** Called on every drive stop: the core sends the neutral command right after. */
  release(): void {
    this.endTest('stopped');
    this.dropLoop(false);
  }

  private dropLoop(stop: boolean): void {
    const loop = this.loop;
    // Detach first: our own stop must not come back as a board stop.
    this.offStopped?.();
    this.offStopped = null;
    this.loop = null;
    this.loopMode = null;
    if (stop && loop?.active) loop.stop();
    if (loop) this.emit();
  }

  private command(c: Command): void {
    const key = c.mode === 'closed' ? this.ctx.modeKey : this.ctx.openMode?.key;
    if (!key) throw new TestAborted('rejected');
    if (this.loop && !this.loop.active) {
      // Somebody else (host: BOOT/E-STOP/fault, core) ended the session. Restarting it here
      // would drive a board the user did not re-arm.
      this.boardStopped();
      throw new TestAborted('board');
    }
    if (!this.loop) {
      this.loop = this.device.control.start(key, c.value, { rateHz: CONTROL_RATE_HZ });
      this.loopMode = c.mode;
      this.watchLoop(this.loop);
      this.emit();
      return;
    }
    if (this.loopMode !== c.mode) {
      this.loop.setMode(key, c.value);
      this.loopMode = c.mode;
    } else this.loop.update(c.value);
  }

  /** The host tells why it ended a session (BOOT, E-STOP, fault, renumbering, link loss …). */
  private watchLoop(loop: ControlLoop): void {
    this.offStopped = loop.onStopped((reason) => {
      if (this.loop === loop) this.boardStopped(reason);
    });
  }

  private boardStopped(reason: ControlStopReason | null = this.loop?.stopReason ?? null): void {
    if (!this.loop) return;
    this.dropLoop(false);
    this.endTest('board');
    for (const cb of this.haltListeners) cb(reason);
  }

  // ---- tests -----------------------------------------------------------------------------------

  /**
   * Runs a program; resolves with the capture or rejects with `TestAborted`. Every command is
   * checked against the mode range and the test limits first: an out-of-limit command aborts
   * the test and is never sent.
   */
  runTest(program: TestProgram, limits: TestLimits): Promise<Capture> {
    if (this.test) return Promise.reject(new TestAborted('rejected'));
    if (!this.sub) this.open();
    return new Promise<Capture>((resolve, reject) => {
      const a: ActiveTest = {
        program,
        cap: { kind: program.kind, t: [], ch: this.ctx.streamKeys.map(() => []), cmd: [], lost: 0, periodUs: this.periodUs },
        t0: NaN,
        lastSampleAt: this.env.now(),
        lost0: this.lost,
        resolve,
        reject,
        watchdog: undefined,
        mode: null,
        lastValue: NaN,
        synced: false,
      };
      this.limits = limits;
      this.test = a;
      const tick = (): void => {
        if (this.test !== a) return;
        if (this.env.now() - a.lastSampleAt > 400) return this.abort('stream');
        a.watchdog = this.env.setTimeout(tick, 100);
      };
      a.watchdog = this.env.setTimeout(tick, 100);
      this.emit();
    });
  }


  private feed(a: ActiveTest, tAbs: number, v: Float32Array): void {
    // The host may end the session without telling us (older host, board reset): check on
    // every sample, never keep a test "running" over a dead loop.
    if (this.loop && !this.loop.active) return this.boardStopped();
    a.lastSampleAt = this.env.now();
    if (Number.isNaN(a.t0)) a.t0 = tAbs;
    const t = tAbs - a.t0;
    const lim = this.limits;
    // Measurement guard: open-loop tests must stay inside the allowed region.
    const meas = v[this.ctx.idx.measured]!;
    if (lim && Number.isFinite(meas)) {
      if (this.ctx.integrating) {
        const margin = 0.1 * (lim.rangeMax - lim.rangeMin);
        if (meas < lim.rangeMin - margin || meas > lim.rangeMax + margin) return this.abort('range');
      } else if (Math.abs(meas) > lim.maxAmplitude * 1.15) return this.abort('range');
    }
    const cmd = t > a.program.maxDuration || (lim && t > lim.maxDuration) ? null : a.program.next(t, v);
    // The first samples still show the target held before the test; an edge from that stale
    // value is not part of the test. Wait (≤ 100 ms) until the board echoes the first command.
    if (!a.synced) {
      const echoed = v[this.ctx.idx.target];
      const want = a.mode === 'closed' ? a.lastValue : NaN;
      if (t > 0.1 || this.ctx.idx.target < 0 || a.mode === 'open' || (echoed !== undefined && Math.abs(echoed - want) <= 1e-4 * Math.max(1, Math.abs(want))))
        a.synced = a.mode !== null;
    }
    if (a.synced) {
      a.cap.t.push(t);
      for (let i = 0; i < v.length; i++) a.cap.ch[i]!.push(v[i]!);
      a.cap.cmd.push(a.mode === 'open' ? a.lastValue : NaN);
    }
    if (cmd === null) return this.finish(a, v);
    if (lim) {
      if (cmd.mode === 'closed' && targetBlock(this.ctx, lim, cmd.value)) return this.abort('limit');
      if (cmd.mode === 'open') {
        const om = this.ctx.openMode;
        if (!om || !(Math.abs(cmd.value) <= lim.maxOpen + 1e-9) || cmd.value < om.min || cmd.value > om.max) return this.abort('limit');
      }
    }
    if (cmd.mode !== a.mode || cmd.value !== a.lastValue) {
      try {
        this.command(cmd);
      } catch {
        return this.abort('rejected');
      }
      a.mode = cmd.mode;
      a.lastValue = cmd.value;
    }
  }

  private finish(a: ActiveTest, v: Float32Array): void {
    this.env.clearTimeout(a.watchdog);
    this.test = null;
    a.cap.lost = this.lost - a.lost0;
    let after: Command | null = null;
    try {
      after = a.program.after(v);
      if (after && this.limits && after.mode === 'closed' && targetBlock(this.ctx, this.limits, after.value)) after = null;
      if (after && after.mode !== 'closed') after = null;
      if (after) {
        this.holdTarget = after.value;
        this.command(after);
      }
    } catch {
      after = null;
    }
    // No safe closed-loop hold: end the session (neutral) rather than keep the last command.
    if (!after) this.dropLoop(true);
    a.resolve(a.cap);
    this.emit();
  }

  /**
   * Aborts the running test (no-op when idle) and leaves the board safe: an open-loop command
   * never survives an abort. A user stop or a limit hit returns to the safe closed-loop target
   * (speed 0 / present position); a range, stream, board or program error ends the control
   * session (neutral) because the measurement or the loop can no longer be trusted.
   */
  abort(reason: AbortReason): void {
    if (!this.test) return;
    const loop = this.loop;
    if (loop?.active) {
      if (reason === 'stopped' || reason === 'limit') {
        const safe = this.safeTarget();
        this.holdTarget = safe;
        try {
          if (this.loopMode === 'open') {
            loop.setMode(this.ctx.modeKey, safe);
            this.loopMode = 'closed';
          } else loop.update(safe);
        } catch {
          this.dropLoop(true);
        }
      } else this.dropLoop(true);
    }
    this.endTest(reason);
  }

  /** Settles the test promise without commanding anything. */
  private endTest(reason: AbortReason): void {
    const a = this.test;
    if (!a) return;
    this.env.clearTimeout(a.watchdog);
    this.test = null;
    a.reject(new TestAborted(reason));
    this.emit();
  }
}

// ---- programs -------------------------------------------------------------------------------

/**
 * Closed-loop test from the signal generator. Afterwards it holds `rest` (a spinning mechanism
 * comes back to rest) or, without one, the profile's last value (a positioned one stays).
 */
export function closedProgram(cfg: SignalConfig, rest?: number): TestProgram {
  const T = signalDuration(cfg);
  return {
    kind: 'closed',
    maxDuration: Number.isFinite(T) ? T + 0.05 : 0,
    next: (t) => (t > T ? null : { mode: 'closed', value: signalValue(cfg, t) }),
    after: () => ({ mode: 'closed', value: rest ?? signalValue(cfg, T) }),
  };
}

export interface FfOptions {
  /** Largest open-loop ratio. */
  maxOpen: number;
  /** Speed at which the ramp stops climbing (measured units). */
  maxSpeed: number;
  /** Stream index of the measured speed. */
  measured: number;
  /** Ramp time to maxOpen, s. */
  rampTime?: number;
}

/**
 * Feed-forward characterisation (open loop): slow ramp up (quasi-static: kS, kV), two steps
 * (acceleration: kA), coast, then the same ramp in reverse for a symmetric kS.
 * The ramp stops climbing at maxOpen or at 80 % of the allowed speed, whichever comes first.
 */
export function ffProgram(o: FfOptions): TestProgram {
  const ramp = o.rampTime ?? 3;
  const rate = o.maxOpen / ramp;
  let phase = 0;
  let phaseT = 0;
  let top = 0;
  let d = 0;
  const go = (t: number, p: number): void => {
    phase = p;
    phaseT = t;
  };
  const fast = (v: Float32Array): boolean => Math.abs(v[o.measured] ?? 0) >= 0.8 * o.maxSpeed;
  return {
    kind: 'ff',
    maxDuration: 4 * ramp + 6,
    next(t, v) {
      const dt = t - phaseT;
      switch (phase) {
        case 0: // ramp up
          d = Math.min(o.maxOpen, rate * dt);
          if (d >= o.maxOpen || fast(v)) {
            top = d;
            go(t, 1);
          }
          return { mode: 'open', value: d };
        case 1: // hold the top
          if (dt > 0.4) go(t, 2);
          return { mode: 'open', value: top };
        case 2: // step down to half
          if (dt > 0.8) go(t, 3);
          return { mode: 'open', value: top * 0.5 };
        case 3: // step back up
          if (dt > 0.8) go(t, 4);
          return { mode: 'open', value: top };
        case 4: // coast down
          if (dt > 1.2) go(t, 5);
          return { mode: 'open', value: 0 };
        case 5: // reverse ramp
          d = -Math.min(top, rate * dt);
          if (-d >= top || fast(v)) go(t, 6);
          return { mode: 'open', value: d };
        case 6:
          if (dt > 0.4) go(t, 7);
          return { mode: 'open', value: d };
        default:
          return dt > 1 ? null : { mode: 'open', value: 0 };
      }
    },
    after: () => ({ mode: 'closed', value: 0 }),
  };
}

export interface IdentOptions {
  /** Open-loop step size (ratio). */
  step: number;
  maxSpeed: number;
  measured: number;
  /** Lead-in and step length, s. */
  pre?: number;
  hold?: number;
}

/**
 * Open-loop step for a self-regulating process. Ends early (keeping the data) when the speed
 * nears the test limit, so a mis-sized step never runs away.
 */
export function identStepProgram(o: IdentOptions): TestProgram {
  const pre = o.pre ?? 0.3;
  const hold = o.hold ?? 2.5;
  return {
    kind: 'ident',
    maxDuration: pre + hold + 0.1,
    next(t, v) {
      if (t > pre + hold || Math.abs(v[o.measured] ?? 0) >= 0.95 * o.maxSpeed) return null;
      return { mode: 'open', value: t < pre ? 0 : o.step };
    },
    after: () => ({ mode: 'closed', value: 0 }),
  };
}

export interface RelayOptions {
  /** Centre of the oscillation (closed-loop target held first). */
  centre: number;
  /** Relay amplitude (open-loop ratio). */
  amplitude: number;
  /** Hysteresis in measured units. */
  hysteresis: number;
  /** Oscillation periods to record after the first one. */
  cycles: number;
  measured: number;
  /** Stream index of the open mode's measured ratio (bias); −1 when unknown. */
  duty: number;
  /** Closed-loop hold before the relay (finds the bias that holds the load), s. */
  settle?: number;
  /** Largest |bias| (ratio); keeps bias ± amplitude inside the open-loop limit. */
  maxBias: number;
  /** Closed-loop target held afterwards (default: the centre). */
  rest?: number;
}

function clampAbs(v: number, m: number): number {
  return v > m ? m : v < -m ? -m : v;
}

/**
 * Åström–Hägglund relay around `centre`. The closed loop first holds the centre; the average
 * applied ratio there becomes the relay bias (gravity, friction), so the oscillation stays
 * symmetric. Then u = bias ± amplitude switches on the sign of the error with hysteresis.
 */
export function relayProgram(o: RelayOptions): TestProgram {
  const settle = o.settle ?? 1.2;
  let biasSum = 0;
  let biasN = 0;
  let bias = 0;
  let out = 1;
  let started = -1;
  let ups = 0;
  let lastSwitch = -1;
  let highTime = 0;
  return {
    kind: 'relay',
    maxDuration: settle + 30,
    next(t, v) {
      const y = v[o.measured] ?? NaN;
      if (t < settle) {
        if (t > settle * 0.5 && o.duty >= 0) {
          const dv = v[o.duty] ?? NaN;
          if (Number.isFinite(dv)) {
            biasSum += dv;
            biasN++;
          }
        }
        return { mode: 'closed', value: o.centre };
      }
      if (started < 0) {
        started = t;
        bias = clampAbs(biasN ? biasSum / biasN : 0, o.maxBias);
        out = Number.isFinite(y) && y > o.centre ? -1 : 1;
        lastSwitch = t;
      }
      let next = out;
      if (Number.isFinite(y)) {
        if (y > o.centre + o.hysteresis) next = -1;
        else if (y < o.centre - o.hysteresis) next = 1;
      }
      if (next !== out) {
        if (out === 1) highTime = t - lastSwitch;
        else if (highTime > 0) {
          // A full period ended. A long "push up" half means the load (gravity, friction)
          // eats into it: move the bias towards it so the oscillation becomes symmetric.
          // The first period still carries the approach transient and is not used.
          const lowTime = t - lastSwitch;
          if (ups > 0) bias = clampAbs(bias + 0.5 * o.amplitude * ((highTime - lowTime) / (lowTime + highTime)), o.maxBias);
          ups++;
        }
        out = next;
        lastSwitch = t;
      }
      if (ups > o.cycles + 2) return null;
      return { mode: 'open', value: bias + out * o.amplitude };
    },
    after: () => ({ mode: 'closed', value: o.rest ?? o.centre }),
  };
}
