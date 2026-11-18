import { describe, expect, it, vi } from 'vitest';
import { runMotorTest, type TestDevice, type Wait } from './motorTest';

function fakes(opts: { enabled?: boolean } = {}) {
  const log: string[] = [];
  let armed = true;
  let releaseSet: (() => void) | null = null;
  const session = {
    get armed() {
      return armed;
    },
    disarm: vi.fn(() => {
      armed = false;
      log.push('disarm');
    }),
  };
  const d = {
    cachedParam: () => (opts.enabled ? 1 : 0),
    setParam: (k: string) => {
      log.push(`set ${k}`);
      return new Promise<number>((r) => (releaseSet = () => r(1)));
    },
    control: {
      start: (m: string, v: number) => void log.push(`start ${m} ${v}`),
      send: (k: string) => void log.push(`send ${k}`),
      stop: () => void log.push('stop'),
    },
  } as unknown as TestDevice;
  return { log, session, d, cut: () => (armed = false), finishSet: () => releaseSet?.() };
}

const instant: Wait = () => Promise.resolve();

describe('runMotorTest (uygulama #9)', () => {
  it('drives for the test time, then always sends neutral and disarms', async () => {
    const f = fakes();
    const out = await runMotorTest(f.session, f.d, { kind: 'duty', duty: 0.1 }, new AbortController().signal, instant);
    expect(out).toBe('done');
    expect(f.log).toEqual(['start duty 0.1', 'stop', 'disarm']);
  });

  it('does not start driving when the session was cut while enabling the channel', async () => {
    const f = fakes();
    const p = runMotorTest(f.session, f.d, { kind: 'channel', channel: 6, pulseUs: 1700 }, new AbortController().signal, instant);
    f.cut(); // focus loss during the await
    f.finishSet();
    expect(await p).toBe('cancelled');
    expect(f.log.some((l) => l.startsWith('send'))).toBe(false);
    expect(f.log).toContain('stop');
  });

  it('stops at once when aborted (unmount) mid-test', async () => {
    const f = fakes({ enabled: true });
    const ac = new AbortController();
    let waited: (() => void) | null = null;
    const wait: Wait = (_ms, signal) => new Promise((r) => { waited = r; signal.addEventListener('abort', () => r()); });
    const p = runMotorTest(f.session, f.d, { kind: 'channel', channel: 2, pulseUs: 1700 }, ac.signal, wait);
    await Promise.resolve();
    expect(waited).not.toBeNull();
    ac.abort();
    expect(await p).toBe('cancelled');
    expect(f.log).toEqual(['send channels_1_4', 'stop', 'disarm']);
  });

  it('still sends neutral when the write fails', async () => {
    const f = fakes();
    (f.d as { setParam: unknown }).setParam = () => Promise.reject(new Error('timeout'));
    await expect(runMotorTest(f.session, f.d, { kind: 'channel', channel: 1, pulseUs: 1700 }, new AbortController().signal, instant)).rejects.toThrow('timeout');
    expect(f.log).toEqual(['stop', 'disarm']);
  });
});
