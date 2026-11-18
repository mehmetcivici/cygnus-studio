import { describe, expect, it } from 'vitest';
import { CATALOG, type DeviceHandle, type ModelDef, type StreamDataCallback } from '@cygnus/protocol';
import { TestAborted, TunerDriver, closedProgram, identStepProgram, relayProgram, type DriverEnv } from './engine';
import { defaultLimits, loopContext, targetBlock } from './loop';
import { defaultSignal } from './signals';

const ESC_80A: ModelDef = CATALOG.find((m) => m.key === 'esc80a')!;

interface Sent {
  kind: 'start' | 'update' | 'mode' | 'stop';
  mode?: string | number;
  value?: number;
}

/** Minimal board: records control commands and lets the test push stream samples. */
function fakeDevice() {
  const sent: Sent[] = [];
  let cb: StreamDataCallback | null = null;
  let active = false;
  const control = {
    get active() {
      return active;
    },
    periodMs: 5,
    set: () => undefined,
    send: () => undefined,
    stop: () => {
      active = false;
      sent.push({ kind: 'stop' });
    },
    start: (mode: string | number, value: number) => {
      active = true;
      sent.push({ kind: 'start', mode, value });
      return {
        get active() {
          return active;
        },
        update: (v: number) => sent.push({ kind: 'update', value: v }),
        setMode: (m: string | number, v = 0) => sent.push({ kind: 'mode', mode: m, value: v }),
        stop: () => control.stop(),
      };
    },
  };
  const stream = {
    active: false,
    slotsUsed: 0,
    open: () => ({
      signals: [],
      periodUs: 1000,
      lost: 0,
      samples: 0,
      closed: false,
      onData: (c: StreamDataCallback) => {
        cb = c;
        return () => (cb = null);
      },
      close: () => undefined,
    }),
  };
  const device = { def: ESC_80A, control, stream } as unknown as DeviceHandle;
  return { device, sent, push: (tMs: number, v: number[]) => cb?.(tMs, Float32Array.from(v)) };
}

const env = (clock: { now: number }): DriverEnv => ({ now: () => clock.now, setTimeout: () => 0, clearTimeout: () => undefined });

describe('TunerDriver', () => {
  const velocity = loopContext(ESC_80A, ESC_80A.tuner.loops.find((l) => l.key === 'velocity')!);
  const position = loopContext(ESC_80A, ESC_80A.tuner.loops.find((l) => l.key === 'position')!);

  it('streams the loop signals plus current and the open-loop ratio, once each', () => {
    expect(velocity.streamKeys).toEqual(['setpoint', 'velocity', 'loop.output', 'error', 'phase.current', 'duty']);
    expect(velocity.openMode?.key).toBe('duty');
    expect(velocity.currentLimitParam).toBe('limits.phase_current_a');
    expect(velocity.periodUs).toBe(1000);
    expect(position.integrating).toBe(true);
  });

  it('runs a step program on the board clock and records from the first echoed command', async () => {
    const clock = { now: 0 };
    const f = fakeDevice();
    const d = new TunerDriver(f.device, velocity, env(clock));
    d.open();
    const lim = defaultLimits(velocity);
    const p = d.runTest(closedProgram({ ...defaultSignal('step', 1000, 0), pre: 0.1, hold: 0.2 }), lim);
    // Stale target (1500) from the previous hold, then the board echoes 0.
    let echoed = 1500;
    for (let i = 0; i <= 600; i++) {
      if (i === 3) echoed = 0;
      const last = f.sent.at(-1);
      if (i > 3 && last?.value !== undefined) echoed = last.value;
      f.push(1000 + i, [echoed, 0, 0, 0, 0, 0]);
    }
    const cap = await p;
    expect(cap.t[0]).toBeCloseTo(0.003, 6);
    expect(cap.ch[0]!.includes(1500)).toBe(false);
    expect(f.sent[0]).toEqual({ kind: 'start', mode: 'velocity', value: 0 });
    expect(f.sent.some((s) => s.kind === 'update' && s.value === 1000)).toBe(true);
    expect(cap.t.at(-1)!).toBeLessThan(0.6);
  });

  it('never sends a target outside the test limits: the test aborts first', async () => {
    const clock = { now: 0 };
    const f = fakeDevice();
    const d = new TunerDriver(f.device, velocity, env(clock));
    d.open();
    const lim = { ...defaultLimits(velocity), maxAmplitude: 500 };
    expect(targetBlock(velocity, lim, 1000)).toBe('amplitude');
    const p = d.runTest(closedProgram({ ...defaultSignal('step', 1000, 0), pre: 0.05, hold: 0.2 }), lim);
    for (let i = 0; i < 200; i++) f.push(i, [0, 0, 0, 0, 0, 0]);
    await expect(p).rejects.toEqual(new TestAborted('limit'));
    expect(f.sent.every((s) => s.value === undefined || Math.abs(s.value) <= 500)).toBe(true);
  });

  it('stops an open-loop test when the measurement leaves the allowed region', async () => {
    const clock = { now: 0 };
    const f = fakeDevice();
    const d = new TunerDriver(f.device, velocity, env(clock));
    d.open();
    const lim = { ...defaultLimits(velocity), maxAmplitude: 1000, maxOpen: 0.5 };
    const p = d.runTest(identStepProgram({ step: 0.3, maxSpeed: 5000, measured: velocity.idx.measured }), lim);
    for (let i = 0; i < 400; i++) f.push(i, [0, i * 5, 0, 0, 0, 0]);
    await expect(p).rejects.toEqual(new TestAborted('range'));
    // The open-loop command is withdrawn at once.
    expect(f.sent.at(-1)?.kind).toBe('stop');
  });

  it('aborts the running test when the drive is released (E-STOP, focus loss …)', async () => {
    const clock = { now: 0 };
    const f = fakeDevice();
    const d = new TunerDriver(f.device, velocity, env(clock));
    d.open();
    const p = d.runTest(closedProgram({ ...defaultSignal('step', 100, 0), hold: 1 }), defaultLimits(velocity));
    f.push(0, [0, 0, 0, 0, 0, 0]);
    d.release();
    await expect(p).rejects.toEqual(new TestAborted('stopped'));
    expect(d.testing).toBe(false);
  });

  it('relay: holds the centre, then switches bias ± amplitude on the error sign', async () => {
    const clock = { now: 0 };
    const f = fakeDevice();
    const d = new TunerDriver(f.device, position, env(clock));
    d.open();
    const lim = { ...defaultLimits(position, 0), maxOpen: 0.5 };
    const p = d.runTest(
      relayProgram({ centre: 0.1, amplitude: 0.1, hysteresis: 0.001, cycles: 2, measured: 1, duty: 5, maxBias: 0.4, settle: 0.2 }),
      lim,
    );
    // A crude integrating plant: position follows the sign of the last open-loop command.
    let y = 0.1;
    let u = 0;
    for (let i = 0; i < 4000; i++) {
      const last = f.sent.at(-1);
      if (last?.kind === 'mode' || last?.kind === 'update') u = last.value ?? 0;
      if (f.sent.some((s) => s.kind === 'mode')) y += (u - 0.05) * 0.01;
      f.push(i, [0.1, y, u * 12, 0, 0, 0.05]);
      if (!d.testing) break;
    }
    const cap = await p;
    expect(f.sent.find((s) => s.kind === 'mode')?.mode).toBe('duty');
    // Bias from the hold (duty 0.05) ± amplitude.
    const opens = cap.cmd.filter((c) => Number.isFinite(c));
    expect(Math.max(...opens)).toBeCloseTo(0.15, 2);
    expect(Math.min(...opens)).toBeCloseTo(-0.05, 2);
    // Afterwards the loop holds the centre again in closed loop.
    expect(f.sent.at(-1)).toEqual({ kind: 'mode', mode: 'position', value: 0.1 });
  });
});
