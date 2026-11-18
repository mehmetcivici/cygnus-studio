import type { DeviceHandle } from '@cygnus/protocol';

export const TEST_MS = 1000;
export const TEST_DUTY = 0.1;

/** What a one-second slot test drives: a motor board in duty mode, or one servo-board channel. */
export type TestPlan = { kind: 'duty'; duty: number } | { kind: 'channel'; channel: number; pulseUs: number };

export interface TestSession {
  readonly armed: boolean;
  disarm(): void;
}

export type TestDevice = Pick<DeviceHandle, 'cachedParam' | 'setParam' | 'control'>;

/** Resolves after `ms`, or as soon as `signal` aborts. Injected so tests never wait. */
export type Wait = (ms: number, signal: AbortSignal) => Promise<void>;

export const realWait: Wait = (ms, signal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done(): void {
      clearTimeout(t);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done);
  });

export type TestOutcome = 'done' | 'cancelled';

/**
 * Runs the test pulse. Every await is followed by a fresh session check (a focus loss or
 * navigation can cut the session while a parameter write is in flight), and the board always
 * gets its neutral command in `finally`, whatever happened.
 */
export async function runMotorTest(session: TestSession, d: TestDevice, plan: TestPlan, signal: AbortSignal, wait: Wait = realWait, durationMs = TEST_MS): Promise<TestOutcome> {
  const live = (): boolean => session.armed && !signal.aborted;
  try {
    if (!live()) return 'cancelled';
    if (plan.kind === 'channel') {
      const ch = plan.channel;
      // A factory-fresh channel does not pulse until enabled; the plan enables it for good later.
      if (d.cachedParam(`ch.${ch}.enable`) !== 1) await d.setParam(`ch.${ch}.enable`, 1);
      if (!live()) return 'cancelled';
      const first = Math.floor((ch - 1) / 4) * 4 + 1;
      const pulses = [0, 0, 0, 0];
      pulses[ch - first] = plan.pulseUs;
      d.control.send(`channels_${first}_${first + 3}`, { pulsesUs: pulses }, { repeat: true });
    } else {
      d.control.start('duty', plan.duty);
    }
    await wait(durationMs, signal);
    return live() ? 'done' : 'cancelled';
  } finally {
    d.control.stop();
    session.disarm();
  }
}
