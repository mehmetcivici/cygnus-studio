// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { CATALOG, type ControlStopCallback, type ModelDef } from '@cygnus/protocol';
import { setLang } from '../../../i18n';

// Regression (review uygulama #2): after an automatic cut, holding "Enable" again drove the board
// straight back to the previous target. Every arm must start from neutral.

type Listener = () => void;
vi.hoisted(() => {
  // uPlot (pulled in by the ui barrel) reads matchMedia at import time; jsdom has none.
  window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener: () => undefined, removeEventListener: () => undefined, addListener: () => undefined, removeListener: () => undefined, onchange: null, dispatchEvent: () => false })) as typeof window.matchMedia;
});
const fake = vi.hoisted(() => ({
  armed: false,
  gen: 0,
  disarmListeners: new Set<() => void>(),
  starts: [] as Array<{ mode: string | number; value: number }>,
  sends: [] as Array<{ key: string; pulses: readonly number[] }>,
  updates: [] as number[],
  stops: 0,
  stoppedCbs: [] as Array<(r: string) => void>,
  controlActive: true,
  rerender: null as null | Listener,
}));

vi.mock('../../../core', () => {
  const control = {
    get active() {
      return fake.controlActive;
    },
    start: (mode: string | number, value: number) => {
      fake.starts.push({ mode, value });
      let live = true;
      return {
        get active() {
          return live;
        },
        stopReason: null,
        update: (v: number) => live && fake.updates.push(v),
        setMode: () => undefined,
        stop: () => {
          live = false;
          fake.stops++;
        },
        onStopped: (cb: ControlStopCallback) => {
          fake.stoppedCbs.push(cb as (r: string) => void);
          return () => undefined;
        },
      };
    },
    send: (key: string, f: { pulsesUs: readonly number[] }) => fake.sends.push({ key, pulses: f.pulsesUs }),
    stop: () => fake.stops++,
  };
  const session = {
    get armed() {
      return fake.armed;
    },
    device: { control },
    onDisarm: (cb: () => void) => {
      fake.disarmListeners.add(cb);
      return () => fake.disarmListeners.delete(cb);
    },
    disarm: () => undefined,
  };
  return {
    useDriveSession: () => ({ session, armed: fake.armed, armGeneration: fake.gen, busyOwner: null }),
    ArmButton: () => null,
    useParam: () => ({ value: undefined }),
    useSignal: () => NaN,
  };
});
vi.mock('../../../app/nav', () => ({ navigate: () => undefined }));
vi.mock('../../../ui', async (orig) => ({ ...(await orig<typeof import('../../../ui')>()), LiveChart: () => null }));

const { ControlTab } = await import('./ControlTab');

afterEach(() => {
  cleanup();
  Object.assign(fake, { armed: false, gen: 0, starts: [], sends: [], updates: [], stops: 0, stoppedCbs: [], controlActive: true });
  fake.disarmListeners.clear();
});

function view(def: ModelDef) {
  return {
    uid48: 'aabbccddeeff',
    def,
    online: true,
    handle: { getSignal: () => 0, onSignals: () => () => undefined },
  } as unknown as Parameters<typeof ControlTab>[0]['device'];
}

function mount(def: ModelDef) {
  setLang('tr');
  const r = render(<ControlTab device={view(def)} />);
  const update = (): void => r.rerender(<ControlTab device={view(def)} />);
  const arm = (): void =>
    act(() => {
      fake.armed = true;
      fake.gen++;
      update();
    });
  const cut = (): void =>
    act(() => {
      for (const cb of fake.disarmListeners) cb();
      fake.armed = false;
      update();
    });
  return { arm, cut };
}

describe('Device › Control re-arm (uygulama #2)', () => {
  it('a velocity target never survives a cut: re-arm starts at 0', () => {
    const esc = CATALOG.find((m) => m.key === 'esc80a')!;
    const { arm, cut } = mount(esc);
    const field = () => screen.getAllByLabelText('Hedef')[0] as HTMLInputElement;
    // Disarmed: the target cannot be set.
    expect(field().disabled).toBe(true);
    arm();
    expect(fake.starts.at(-1)?.value).toBe(0);
    fireEvent.focus(field());
    fireEvent.change(field(), { target: { value: '3000' } });
    fireEvent.keyDown(field(), { key: 'Enter' });
    fireEvent.blur(field());
    expect(fake.updates.at(-1)).toBe(3000);
    cut();
    expect(field().value).toBe('0');
    arm();
    expect(fake.starts.map((s) => s.value)).toEqual([0, 0]);
    expect(fake.updates.filter((v) => v === 3000)).toHaveLength(1);
  });

  it('the host ending the loop (BOOT/E-STOP) resets the target', () => {
    const esc = CATALOG.find((m) => m.key === 'esc80a')!;
    const { arm } = mount(esc);
    arm();
    const field = screen.getAllByLabelText('Hedef')[0] as HTMLInputElement;
    fireEvent.focus(field);
    fireEvent.change(field, { target: { value: '2000' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    fireEvent.blur(field);
    act(() => fake.stoppedCbs.forEach((cb) => cb('boardReset')));
    expect(field.value).toBe('0');
  });

  it('servo16: every channel is off after a cut and after re-arm', () => {
    const servo = CATALOG.find((m) => m.key === 'servo16')!;
    const { arm, cut } = mount(servo);
    arm();
    const box = screen.getAllByRole('checkbox')[0] as HTMLInputElement;
    act(() => {
      fireEvent.click(box);
    });
    expect(fake.sends.slice(-4).some((f) => f.pulses.some((p) => p > 0))).toBe(true);
    cut();
    arm();
    expect(fake.sends.slice(-4).every((f) => f.pulses.every((p) => p === 0))).toBe(true);
  });
});
