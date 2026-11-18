import { DevType, ManualScheduler, Model, defaultStatusLoad, getModel, type DeviceHandle, type SignalUpdate } from '@cygnus/protocol';
import { describe, expect, it } from 'vitest';
import { applyPlan, detectMovedEncoder, getTemplate, planApply, planDevices, type ApplyBus, type PlanDevice, type VehicleConfig } from '../src';

const ESC = DevType.MOTOR_CONTROLLER;
const swerve = getTemplate('frc.swerve4')!;

describe('planApply edge cases (review host-sim #10, #11)', () => {
  it('plans nothing else for a board that gets no number', () => {
    const devices: PlanDevice[] = [];
    for (let n = 1; n <= 62; n++) devices.push({ uid48: `x${n}`, model: 'esc20a', devType: ESC, num: n, name: '' });
    devices.push({ uid48: 'new', model: 'esc20a', devType: ESC, num: 63, name: '' });
    const cfg: VehicleConfig = { templateId: swerve.id, name: 'v', bindings: { 'fl.steer': { kind: 'device', uid48: 'new', model: 'esc20a' } } };
    const { steps, warnings } = planApply(swerve, cfg, devices);
    expect(warnings.map((w) => w.code)).toContain('numExhausted');
    expect(steps.filter((s) => s.uid48 === 'new')).toEqual([]);
  });

  it('keeps the numbers of lost and unknown boards reserved and never binds them', () => {
    const lost = { uid48: 'lost', model: 'esc20a', devType: ESC, num: 1, name: '', online: false } satisfies PlanDevice;
    const fresh: PlanDevice = { uid48: 'fresh', model: 'esc20a', devType: ESC, num: 63, name: '' };
    const cfg: VehicleConfig = {
      templateId: swerve.id,
      name: 'v',
      bindings: {
        'fl.drive': { kind: 'device', uid48: 'fresh', model: 'esc20a' },
        'fr.drive': { kind: 'device', uid48: 'lost', model: 'esc20a' },
      },
    };
    const { steps, warnings } = planApply(swerve, cfg, [lost, fresh]);
    const assign = steps.find((s) => s.kind === 'assignNum');
    expect(assign).toMatchObject({ uid48: 'fresh', to: 2 });
    expect(warnings.find((w) => w.uid48 === 'lost')?.code).toBe('deviceNotFound');
    expect(steps.some((s) => s.uid48 === 'lost')).toBe(false);
  });

  it('planDevices lists lost and unknown-model boards as reserved', () => {
    const h = (o: Partial<DeviceHandle>): DeviceHandle =>
      ({ uid48: 'a', model: Model.ESC_20A, def: getModel(Model.ESC_20A), devType: ESC, num: 1, name: '', params: new Map(), online: true, ...o }) as unknown as DeviceHandle;
    const out = planDevices([h({ uid48: 'a' }), h({ uid48: 'b', num: 2, online: false }), h({ uid48: 'c', num: 3, model: 99, def: undefined })]);
    expect(out.map((d) => [d.uid48, d.online])).toEqual([
      ['a', true],
      ['b', false],
      ['c', false],
    ]);
  });
});

describe('applyPlan', () => {
  it('stops running control loops before renumbering', async () => {
    let stopped = 0;
    const d = {
      uid48: 'aa',
      devType: ESC,
      num: 63,
      control: {
        active: true,
        stop: () => {
          stopped++;
          d.control.active = false;
        },
      },
    };
    const bus: ApplyBus = {
      devices: [d as unknown as DeviceHandle],
      deviceByUid: () => d as unknown as DeviceHandle,
      assignId: async () => {
        if (d.control.active) throw new Error('BUSY');
      },
    };
    const r = await applyPlan(bus, [{ kind: 'assignNum', uid48: 'aa', slotId: 's', devType: ESC, from: 63, to: 1 }], { persist: false });
    expect(r.ok).toBe(true);
    expect(stopped).toBe(1);
  });
});

/** Minimal encoder handle whose position the test moves. */
function encoder(uid48: string) {
  const listeners = new Set<(u: SignalUpdate) => void>();
  const state = { position: 0, velocity: 0 };
  const handle = {
    uid48,
    def: getModel(Model.CYNCODER),
    online: true,
    unassigned: false,
    conflict: false,
    capabilities: { signals: true },
    getSignal: (k: string) => (k === 'position' ? state.position : k === 'velocity' ? state.velocity : NaN),
    onSignals: (cb: (u: SignalUpdate) => void) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  } as unknown as DeviceHandle;
  return {
    handle,
    set(p: number, rpm = 0) {
      state.position = p;
      state.velocity = rpm;
      for (const cb of listeners) cb({ t: 0, frame: 0, keys: ['position'], values: {} });
    },
  };
}

describe('detectMovedEncoder (review host-sim #12)', () => {
  it('ignores a shaft that is already turning and finds the one turned by hand', async () => {
    const sched = new ManualScheduler();
    const spinning = encoder('spin');
    spinning.set(0, 60);
    const hand = encoder('hand');
    const p = detectMovedEncoder({ devices: [spinning.handle, hand.handle], scheduler: sched }, { timeoutMs: 5000 });
    let found: string | null | undefined;
    p.then((r) => (found = r?.device.uid48 ?? null));
    // The driven shaft turns 1 rev/s from the start; the hand turn begins after a second.
    for (let t = 1; t <= 2000; t += 10) {
      sched.advance(10);
      spinning.set(t / 1000, 60);
      hand.set(t > 1000 ? (t - 1000) / 2000 : 0, t > 1000 ? 30 : 0);
      await Promise.resolve();
      if (found !== undefined) break;
    }
    expect(found).toBe('hand');
  });
});

describe('bus budget (review protokol #19, PROTOCOL §10.1)', () => {
  it('a 25-board swerve robot stays under 35 % with the default STATUS periods', () => {
    const count = (role: string): number => swerve.slots.filter((s) => s.role === role).length;
    // Swerve modules (8 ESC, 4 encoders), gyro and PDH, plus mechanisms up to 25 boards.
    const escs = count('drive') + count('steer') + 10;
    const encs = count('steerEncoder') + 1;
    const boards = escs + encs + 2;
    expect(boards).toBe(25);
    const load =
      escs * defaultStatusLoad(getModel(Model.ESC_80A)!) +
      encs * defaultStatusLoad(getModel(Model.CYNCODER)!) +
      defaultStatusLoad(getModel(Model.GYRO)!) +
      defaultStatusLoad(getModel(Model.POWER_DIST_LARGE)!);
    expect(load).toBeLessThan(0.35);
  });
});
