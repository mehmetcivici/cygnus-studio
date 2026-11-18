import { describe, expect, it, vi } from 'vitest';
import { create } from 'zustand';
import type { DeviceHandle } from '@cygnus/protocol';
import type { DeviceStatus } from '../../ui';
import { DriveController, type DriveState } from './drive';

function setup() {
  const stop = vi.fn();
  const dev = { uid48: 'aa', online: true, capabilities: { control: true }, control: { stop } };
  let connected = true;
  let status: DeviceStatus = 'ok';
  const store = create<DriveState>(() => ({ session: null, estopLatched: false, lastStop: null }));
  const ctl = new DriveController(
    {
      resolve: (uid) => (uid === 'aa' ? (dev as unknown as DeviceHandle) : undefined),
      isConnected: () => connected,
      statusOf: () => status,
      now: () => 1000,
    },
    store,
  );
  return {
    ctl,
    store,
    dev,
    stop,
    setConnected: (c: boolean) => (connected = c),
    setStatus: (s: DeviceStatus) => (status = s),
  };
}

describe('DriveController', () => {
  it('arms, runs stop callbacks then neutral on disarm, and releases', () => {
    const { ctl, store, stop } = setup();
    const s = ctl.requestDrive('tuner', 'aa');
    expect(s).not.toBeNull();
    if (!s) return;
    const order: string[] = [];
    s.onStop(() => order.push('owner'));
    stop.mockImplementation(() => order.push('neutral'));
    expect(s.arm()).toEqual({ ok: true });
    expect(s.armed).toBe(true);
    expect(store.getState().session?.armed).toBe(true);
    s.disarm();
    expect(order).toEqual(['owner', 'neutral']);
    expect(s.armed).toBe(false);
    expect(s.active).toBe(true);
    s.release();
    expect(store.getState().session).toBeNull();
    expect(s.arm()).toEqual({ ok: false, reason: 'ended' });
  });

  it('allows one owner at a time', () => {
    const { ctl } = setup();
    const a = ctl.requestDrive('tuner', 'aa');
    a?.arm();
    expect(ctl.requestDrive('device', 'aa')).toBeNull();
    a?.disarm();
    const b = ctl.requestDrive('device', 'aa');
    expect(b).not.toBeNull();
    // The replaced unarmed session can no longer arm.
    expect(a?.active).toBe(false);
    expect(a?.arm()).toEqual({ ok: false, reason: 'ended' });
  });

  it('cuts on environment events and records why', () => {
    const { ctl, store, stop } = setup();
    const s = ctl.requestDrive('tuner', 'aa');
    s?.arm();
    ctl.cut('blur');
    expect(s?.armed).toBe(false);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(store.getState().lastStop?.reason).toBe('blur');
    // Cutting while nothing is armed does nothing.
    ctl.cut('navigation');
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('does not send neutral frames when the link or board is gone', () => {
    const { ctl, stop, dev, setConnected } = setup();
    const s = ctl.requestDrive('tuner', 'aa');
    s?.arm();
    setConnected(false);
    ctl.cut('disconnected');
    expect(stop).not.toHaveBeenCalled();
    setConnected(true);
    s?.arm();
    dev.online = false;
    ctl.checkDevice();
    expect(s?.armed).toBe(false);
    expect(stop).not.toHaveBeenCalled();
  });

  it('stops on a board fault and refuses to arm a faulted board', () => {
    const { ctl, setStatus, store } = setup();
    const s = ctl.requestDrive('tuner', 'aa');
    s?.arm();
    setStatus('fault');
    ctl.checkDevice();
    expect(s?.armed).toBe(false);
    expect(store.getState().lastStop?.reason).toBe('deviceFault');
    expect(s?.arm()).toEqual({ ok: false, reason: 'deviceFault' });
  });

  it('latches on E-STOP until cleared', () => {
    const { ctl, store } = setup();
    const s = ctl.requestDrive('tuner', 'aa');
    s?.arm();
    ctl.estop();
    expect(s?.armed).toBe(false);
    expect(store.getState().estopLatched).toBe(true);
    expect(s?.arm()).toEqual({ ok: false, reason: 'estopLatched' });
    ctl.clearLatch();
    expect(s?.arm()).toEqual({ ok: true });
  });

  it('refuses to arm while disconnected', () => {
    const { ctl, setConnected } = setup();
    const s = ctl.requestDrive('tuner', 'aa');
    setConnected(false);
    expect(s?.arm()).toEqual({ ok: false, reason: 'notConnected' });
  });

  it('re-arm starts from neutral: onDisarm resets the target, armGeneration increments (uygulama #2)', () => {
    const { ctl, store } = setup();
    const s = ctl.requestDrive('device', 'aa');
    if (!s) throw new Error('no session');
    // The screen contract: target lives in the screen, reset on every disarm.
    let target = 0;
    const armedWith: number[] = [];
    s.onDisarm(() => (target = 0));
    s.onArm((gen) => armedWith.push(gen));
    expect(s.armGeneration).toBe(0);
    s.arm();
    target = 3000;
    ctl.cut('blur');
    expect(target).toBe(0);
    expect(s.arm()).toEqual({ ok: true });
    expect(target).toBe(0);
    expect(armedWith).toEqual([1, 2]);
    expect(store.getState().session?.armGeneration).toBe(2);
    // disarm keeps the generation; only arming bumps it
    s.disarm();
    expect(s.armGeneration).toBe(2);
  });

  it('sends neutral on a user disconnect while the link is still up (uygulama #4)', () => {
    const { ctl, stop } = setup();
    const s = ctl.requestDrive('tuner', 'aa');
    s?.arm();
    ctl.cut('disconnected');
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('refuses to arm while recovery mode broadcasts', () => {
    const store = create<DriveState>(() => ({ session: null, estopLatched: false, lastStop: null }));
    const dev = { uid48: 'aa', online: true, capabilities: { control: true }, control: { stop: vi.fn() } };
    let rec = true;
    const ctl = new DriveController(
      { resolve: () => dev as unknown as DeviceHandle, isConnected: () => true, statusOf: () => 'ok', now: () => 0, recoveryActive: () => rec },
      store,
    );
    const s = ctl.requestDrive('tuner', 'aa');
    expect(s?.arm()).toEqual({ ok: false, reason: 'recovery' });
    rec = false;
    expect(s?.arm()).toEqual({ ok: true });
  });
});
