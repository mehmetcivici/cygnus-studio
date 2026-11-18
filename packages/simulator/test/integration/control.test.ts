import { DeviceState, FaultBit } from '@cygnus/protocol';
import { describe, expect, it } from 'vitest';
import type { EscNode } from '../../src/devices/esc';
import { createScenario } from '../../src/scenarios';
import { connect } from './harness';

describe('host ↔ simulator: control loop and streaming', () => {
  it.each([[true], [false]])('ESC velocity step with a stream (fd=%s): tracks the target, no lost samples', async (fd) => {
    const sim = createScenario('bench.flywheel', { fd });
    const r = await connect(sim);
    await r.discover();
    const d = r.dev('esc');
    expect(await r.settle(d.getParam('can.data_bitrate'))).toBe(fd ? 1 : 0);
    // The bench ships untuned (a tuner demo): feed-forward plus a firmer P term.
    await r.settle(d.setParam('vel.kv', 0.00211));
    await r.settle(d.setParam('vel.kp', 0.01));
    const sub = d.stream.open({ signals: ['setpoint', 'velocity', 'loop.output'], periodUs: 1000 });
    const ts: number[] = [];
    const vel: number[] = [];
    sub.onData((t, v) => {
      ts.push(t);
      vel.push(v[1]!);
    });
    await r.runFor(200);
    const loop = d.control.start('velocity', 1500);
    await r.runFor(2500);
    expect(loop.active).toBe(true);
    expect(d.flags.enabled).toBe(true);
    expect(d.state).toBe(DeviceState.ACTIVE);
    const last = vel.slice(-100);
    const mean = last.reduce((a, b) => a + b, 0) / last.length;
    expect(Math.abs(mean - 1500)).toBeLessThan(75);
    expect(Math.abs(d.getSignal('velocity') - 1500)).toBeLessThan(100);
    loop.update(800);
    await r.runFor(2500);
    expect(Math.abs(vel[vel.length - 1]! - 800)).toBeLessThan(60);
    expect(sub.samples).toBeGreaterThan(5000);
    expect(sub.lost).toBe(0);
    for (let i = 1; i < ts.length; i++) expect(ts[i]! - ts[i - 1]!).toBeGreaterThan(0);
    // Stop: the loop sends neutral once, the board idles.
    loop.stop();
    await r.runFor(50);
    expect((sim.node('esc') as EscNode).isEnabled()).toBe(false);
    await r.until(() => !d.flags.enabled, 1000, 'host sees idle');
    sub.close();
    await r.runFor(50);
    expect(sim.node('esc').streaming).toBe(false);
    // The bus did not drop or overflow anything.
    expect(sim.snapshot().bus.txOverflow).toBe(0);
  });

  it('ctrl.timeout_ms: a single command times out to neutral with CTRL_TIMEOUT warning', async () => {
    const sim = createScenario('bench.flywheel');
    const r = await connect(sim);
    await r.discover();
    const d = r.dev('esc');
    const esc = sim.node('esc') as EscNode;
    await r.settle(d.setParam('ctrl.timeout_ms', 100));
    d.control.set('duty', 0.4);
    await r.runFor(60);
    expect(esc.isEnabled()).toBe(true);
    await r.runFor(80);
    expect(esc.isEnabled()).toBe(false);
    expect(esc.faults.warn & (1 << FaultBit.CTRL_TIMEOUT)).not.toBe(0);
    await r.until(() => d.faults.list.some((f) => f.key === 'ctrl_timeout' && f.kind === 'warn'), 1500, 'host reads the warning');
    // A running loop keeps the board alive well past the timeout (the host repeats fast enough).
    const loop = d.control.start('duty', 0.2);
    expect(d.control.periodMs).toBeLessThanOrEqual(25);
    await r.runFor(600);
    expect(esc.isEnabled()).toBe(true);
    expect(esc.faults.warn & (1 << FaultBit.CTRL_TIMEOUT)).toBe(0);
    loop.stop();
    await r.runFor(20);
    expect(esc.isEnabled()).toBe(false);
  });

  it('bus.estop(): every actuator latches ESTOP, loops end, clearEstop releases', async () => {
    const sim = createScenario('all.devices');
    const r = await connect(sim);
    await r.discover();
    const esc = r.dev('esc80a');
    const servo = r.dev('sealed_servo');
    const loop = esc.control.start('duty', 0.3);
    const sloop = servo.control.start('position', 0.1);
    await r.runFor(300);
    expect((sim.node('esc80a') as EscNode).isEnabled()).toBe(true);
    r.bus.estop();
    expect(loop.active).toBe(false);
    expect(sloop.active).toBe(false);
    await r.runFor(10);
    const actuators = sim.nodes.filter((n) => n.params.has('ctrl.timeout_ms'));
    expect(actuators.length).toBeGreaterThanOrEqual(4);
    for (const n of actuators) {
      expect(n.estopped, n.id).toBe(true);
      expect(n.state).toBe(DeviceState.ESTOP);
      expect(n.isEnabled()).toBe(false);
    }
    await r.until(() => actuators.every((n) => r.dev(n.id).state === DeviceState.ESTOP), 1000, 'host sees ESTOP');
    // Commands are ignored while latched.
    esc.control.set('duty', 0.5);
    await r.runFor(20);
    expect((sim.node('esc80a') as EscNode).isEnabled()).toBe(false);
    for (const n of actuators) await r.settle(r.dev(n.id).clearEstop());
    await r.until(() => actuators.every((n) => r.dev(n.id).state !== DeviceState.ESTOP), 1000, 'ESTOP cleared');
    for (const n of actuators) expect(n.estopped).toBe(false);
    const again = esc.control.start('duty', 0.3);
    await r.runFor(100);
    expect((sim.node('esc80a') as EscNode).isEnabled()).toBe(true);
    again.stop();
  });
});
