import { SeriesBuffer } from '../../ui';

/** Deterministic PRNG so screenshots are reproducible. */
export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/** Approximate unit gaussian. */
function gauss(r: () => number): number {
  return (r() + r() + r() + r() - 2) * 1.22;
}

export interface StepSim {
  setpoint: SeriesBuffer;
  velocity: SeriesBuffer;
  current: SeriesBuffer;
  duty: SeriesBuffer;
  error: SeriesBuffer;
  extras: SeriesBuffer[];
  /** Advance the simulation to wall time `nowSec`, emitting 1 kHz samples. */
  advanceTo: (nowSec: number) => number;
}

/**
 * Closed-loop velocity response of a BLDC to a square-wave setpoint
 * (second-order, ζ≈0.55), sampled at 1 kHz — the kind of trace the Tuner shows.
 */
export function createStepSim(extraCount: number, capacity = 60_000): StepSim {
  const r = rng(7);
  const mk = (): SeriesBuffer => new SeriesBuffer(capacity);
  const sim = {
    setpoint: mk(),
    velocity: mk(),
    current: mk(),
    duty: mk(),
    error: mk(),
    extras: Array.from({ length: extraCount }, mk),
  };
  const dt = 0.001;
  const wn = 14;
  const zeta = 0.5;
  let t = 0;
  let x = 1500;
  let v = 0;
  const advanceTo = (nowSec: number): number => {
    let n = 0;
    // Cap catch-up after a hidden tab so we never block the UI thread.
    if (nowSec - t > 2) t = nowSec - 2;
    while (t + dt <= nowSec) {
      t += dt;
      const phase = t % 3;
      const sp = phase < 1.5 ? 4500 : 1500;
      const acc = wn * wn * (sp - x) - 2 * zeta * wn * v;
      v += acc * dt;
      x += v * dt;
      const meas = x + gauss(r) * 9;
      const amps = 3.2 + v * 0.0021 + x * 0.0009 + gauss(r) * 0.35;
      sim.setpoint.push(t, sp);
      sim.velocity.push(t, meas);
      sim.current.push(t, amps);
      sim.duty.push(t, Math.max(-100, Math.min(100, x / 60 + v * 0.004)));
      sim.error.push(t, sp - meas);
      for (let k = 0; k < sim.extras.length; k++) {
        const b = sim.extras[k];
        b?.push(t, 2000 + 1400 * Math.sin(t * (0.6 + k * 0.37) + k) + gauss(r) * 40);
      }
      n++;
    }
    return n;
  };
  return { ...sim, advanceTo };
}

export interface RunData {
  x: Float64Array;
  y: Float64Array;
}

/** Recorded step responses for several Kp values (overlaid run comparison). */
export function makeRuns(): { kp: number; data: RunData }[] {
  const kps = [0.0008, 0.0014, 0.0022];
  return kps.map((kp, i) => {
    const r = rng(100 + i);
    const n = 1500;
    const dt = 0.001;
    const wn = 8 + kp * 6000;
    const zeta = 1.1 - kp * 330;
    const x = new Float64Array(n);
    const y = new Float64Array(n);
    let p = 0;
    let v = 0;
    for (let k = 0; k < n; k++) {
      const sp = k * dt < 0.1 ? 0 : 3000;
      v += (wn * wn * (sp - p) - 2 * zeta * wn * v) * dt;
      p += v * dt;
      x[k] = k * dt;
      y[k] = p + gauss(r) * 6;
    }
    return { kp, data: { x, y } };
  });
}

export interface CanRow {
  seq: number;
  t: number;
  id: number;
  dlc: number;
  data: string;
  device: string;
  kind: 'status' | 'param' | 'heartbeat' | 'ctrl' | 'fault';
}

const DEVICES = ['ESC 80A #3', 'ESC 80A #4', 'ESC 20A #5', 'Cyncoder #7', 'CAN gyro #1', 'Servo 16 #2'];
const KINDS: CanRow['kind'][] = ['status', 'status', 'status', 'status', 'ctrl', 'heartbeat', 'param'];

export function makeCanRows(count: number): CanRow[] {
  const r = rng(42);
  const rows: CanRow[] = [];
  let t = 0;
  for (let i = 0; i < count; i++) {
    t += 0.0004 + r() * 0.0012;
    const dev = Math.floor(r() * DEVICES.length);
    const kind = i % 997 === 500 ? 'fault' : (KINDS[Math.floor(r() * KINDS.length)] ?? 'status');
    const dlc = kind === 'heartbeat' ? 4 : 8;
    const bytes = Array.from({ length: dlc }, () => Math.floor(r() * 256).toString(16).toUpperCase().padStart(2, '0'));
    const api = { status: 0x10, param: 0x31, heartbeat: 0x01, ctrl: 0x20, fault: 0x0f }[kind];
    rows.push({
      seq: i,
      t,
      id: (0x0a << 16) | (api << 6) | (dev + 3),
      dlc,
      data: bytes.join(' '),
      device: DEVICES[dev] ?? '',
      kind,
    });
  }
  return rows;
}
