import { CyError, type AbortSignalLike, type DeviceHandle, type Scheduler } from '@cygnus/protocol';

/** What the detectors need from the host bus (a `CygnusBus` fits). */
export interface DetectBus {
  readonly devices: readonly DeviceHandle[];
  readonly scheduler: Scheduler;
}

export interface DetectOptions {
  /** Give up after this long and resolve null (default 15 s). */
  timeoutMs?: number;
  /** Aborting rejects with CyError ABORTED. */
  signal?: AbortSignalLike;
  /** Only consider these boards (default: every online, numbered board of the right kind). */
  devices?: readonly DeviceHandle[];
  /**
   * A board already moving when the call starts (a driven shaft, a falling arm: its rate signal
   * is above the limit) is ignored until its rate has stayed below the limit this long; then
   * its baseline restarts there. Default 300 ms.
   */
  settleMs?: number;
}

interface RateRule {
  keys: readonly string[];
  /** Rate above this counts as moving on its own. */
  limit: number;
}

export interface DetectEncoderOptions extends DetectOptions {
  /** Movement that counts, turns (default 0.1). */
  minDeltaRot?: number;
}

export interface DetectGyroOptions extends DetectOptions {
  /** Pitch or roll change that counts, degrees (default 15). */
  minTiltDeg?: number;
}

export interface DetectResult {
  device: DeviceHandle;
  /** How far it moved when it crossed the threshold (turns or degrees). */
  delta: number;
}

const ENCODER_MODELS = new Set(['cyncoder', 'cyncoder_v3']);

/**
 * "Turn it by hand and the Studio finds it": resolves with the first encoder whose multi-turn
 * position moves `minDeltaRot` away from where it was when the call started. Encoders already
 * turning when the call starts (velocity above `minDeltaRot` per second) are ignored until they
 * stand still (see `settleMs`). Boards only send readings once they have a number, so assign
 * numbers before asking the user to turn.
 */
export function detectMovedEncoder(bus: DetectBus, opts: DetectEncoderOptions = {}): Promise<DetectResult | null> {
  const min = opts.minDeltaRot ?? 0.1;
  // `velocity` is in rpm: moving faster than `min` turns per second means it turns on its own.
  const rate: RateRule = { keys: ['velocity'], limit: min * 60 };
  return watchFirst(bus, opts, (d) => d.def !== undefined && ENCODER_MODELS.has(d.def.key), ['position'], (now, base) => Math.abs((now[0] ?? 0) - (base[0] ?? 0)), min, rate);
}

/** Resolves with the first gyro whose pitch or roll changes by `minTiltDeg` (tilt the board or the vehicle). */
export function detectTiltedGyro(bus: DetectBus, opts: DetectGyroOptions = {}): Promise<DetectResult | null> {
  const min = opts.minTiltDeg ?? 15;
  return watchFirst(
    bus,
    opts,
    (d) => d.def?.key === 'gyro',
    ['pitch', 'roll'],
    (now, base) => Math.max(Math.abs((now[0] ?? 0) - (base[0] ?? 0)), Math.abs(angleDiff(now[1] ?? 0, base[1] ?? 0))),
    min,
    { keys: ['gyro.x', 'gyro.y'], limit: min },
  );
}

function angleDiff(a: number, b: number): number {
  let d = a - b;
  while (d > 180) d -= 360;
  while (d < -180) d += 360;
  return d;
}

function watchFirst(
  bus: DetectBus,
  opts: DetectOptions,
  kind: (d: DeviceHandle) => boolean,
  keys: readonly string[],
  distance: (now: readonly number[], base: readonly number[]) => number,
  threshold: number,
  rate: RateRule,
): Promise<DetectResult | null> {
  if (opts.signal?.aborted) return Promise.reject(new CyError('ABORTED', 'aborted'));
  const candidates = (opts.devices ?? bus.devices).filter((d) => kind(d) && d.online && !d.unassigned && !d.conflict && d.capabilities.signals);
  return new Promise<DetectResult | null>((resolve, reject) => {
    const offs: Array<() => void> = [];
    let timer: unknown = undefined;
    const finish = (): void => {
      for (const off of offs) off();
      offs.length = 0;
      if (timer !== undefined) bus.scheduler.clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = (): void => {
      finish();
      reject(new CyError('ABORTED', 'aborted'));
    };
    const read = (d: DeviceHandle): number[] | null => {
      const v = keys.map((k) => d.getSignal(k));
      return v.every(Number.isFinite) ? v : null;
    };
    const settleMs = opts.settleMs ?? 300;
    const rateOf = (d: DeviceHandle): number => {
      let r = 0;
      for (const k of rate.keys) {
        const v = Math.abs(d.getSignal(k));
        if (Number.isFinite(v) && v > r) r = v;
      }
      return r;
    };
    for (const d of candidates) {
      // The baseline is the first complete reading after the call, so readings older than the request do not count.
      let base: number[] | null = read(d);
      let moving = rateOf(d) > rate.limit;
      let movedAt = bus.scheduler.now();
      offs.push(
        d.onSignals(() => {
          const now = read(d);
          if (!now) return;
          if (moving) {
            const t = bus.scheduler.now();
            if (rateOf(d) > rate.limit) movedAt = t;
            else if (t - movedAt >= settleMs) {
              moving = false;
              base = now;
            }
            return;
          }
          if (!base) {
            base = now;
            return;
          }
          const delta = distance(now, base);
          if (delta < threshold) return;
          finish();
          resolve({ device: d, delta });
        }),
      );
    }
    timer = bus.scheduler.setTimeout(() => {
      timer = undefined;
      finish();
      resolve(null);
    }, opts.timeoutMs ?? 15_000);
    opts.signal?.addEventListener('abort', onAbort);
  });
}
