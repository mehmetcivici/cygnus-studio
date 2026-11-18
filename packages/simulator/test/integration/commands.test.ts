import { CommandStatus, DeviceState } from '@cygnus/protocol';
import { describe, expect, it } from 'vitest';
import type { EscNode } from '../../src/devices/esc';
import type { GyroNode } from '../../src/devices/gyro';
import { createScenario } from '../../src/scenarios';
import { connect, cycanNodes } from './harness';

describe('host ↔ simulator: commands and faults', () => {
  it('long commands report progress and their final result; model actions run on the board', async () => {
    const sim = createScenario('all.devices');
    const r = await connect(sim);
    await r.discover();
    const esc = r.dev('esc20a');
    await r.settle(esc.command('set_position', 2.5));
    await r.runFor(100);
    expect(esc.getSignal('position')).toBeCloseTo(2.5, 1);
    expect(await r.caught(esc.command('set_position', 1e9))).toMatchObject({ code: 'INVALID', reason: 'out_of_range' });
    let progress = 0;
    const res = await r.settle(esc.command('measure_motor', 0, { onProgress: () => progress++ }), 20_000);
    expect(progress).toBeGreaterThanOrEqual(1);
    expect(res.status).toBe(CommandStatus.OK);
    expect(await r.settle(esc.getParam('motor.kv_rpm_per_v'))).toBeGreaterThan(0);


    const gyro = r.dev('gyro');
    let gp = 0;
    await r.settle(gyro.command('calibrate', 0, { onProgress: () => gp++ }), 20_000);
    expect(gp).toBeGreaterThanOrEqual(1);
    const g = sim.node('gyro') as GyroNode;
    await r.settle(gyro.command('set_yaw', 90));
    await r.runFor(100);
    expect(g.signalValues().yaw).toBeCloseTo(90, 0);

    const enc = r.dev('cyncoder');
    await r.settle(enc.command('zero_here'));
    await r.runFor(30);
    const abs = sim.node('cyncoder').signalValues()['abs.position']!;
    expect(Math.min(abs, 1 - abs)).toBeLessThan(0.02);

    await r.settle(r.dev('pdh_large').command('reset_energy'));
    await r.settle(r.dev('servo16').command('center_all'));

    // Unknown command code → UNSUPPORTED from the board; unknown key → host refuses.
    expect(await r.caught(enc.command(0x7e))).toMatchObject({ code: 'REJECTED', status: CommandStatus.UNSUPPORTED, statusKind: 'command' });
    expect(await r.caught(enc.command('no_such_action'))).toMatchObject({ code: 'INVALID', reason: 'unknown_command' });

    // DENIED while driven.
    const loop = esc.control.start('duty', 0.2);
    await r.until(() => esc.flags.enabled, 1000, 'enabled');
    expect(await r.caught(esc.command('measure_motor'))).toMatchObject({ code: 'REJECTED', status: CommandStatus.DENIED });
    expect(await r.caught(esc.reboot())).toMatchObject({ code: 'REJECTED', status: CommandStatus.DENIED });
    expect(await r.caught(esc.loadDefaults())).toMatchObject({ code: 'REJECTED', status: CommandStatus.DENIED });
    loop.stop();
  });

  it('abortAction() cancels a running moving command: FAILED, motor stops, nothing written (PROTOCOL §4.5)', async () => {
    const sim = createScenario('all.devices');
    const r = await connect(sim);
    await r.discover();
    const esc = r.dev('esc20a');
    const node = sim.node('esc20a') as EscNode;
    const kv = node.params.getKey('motor.kv_rpm_per_v');
    const p = esc.command('measure_motor');
    await r.runFor(600);
    expect(node.isEnabled()).toBe(true);
    esc.abortAction();
    const e = await r.caught(p, 200);
    expect(e).toMatchObject({ code: 'REJECTED', status: CommandStatus.FAILED });
    await r.runFor(5);
    expect(node.isEnabled()).toBe(false);
    await r.runFor(1500);
    expect(node.params.getKey('motor.kv_rpm_per_v')).toBe(kv);
    // Nothing left pending on the board.
    await r.settle(esc.command('set_position', 0));
  });

  it('self-test passes, and fails with catalog labels when injected', async () => {
    const sim = createScenario('all.devices');
    const r = await connect(sim);
    await r.discover();
    for (const n of cycanNodes(sim)) {
      const st = await r.settle(r.dev(n.id).selfTest(), 5000);
      expect(st.passed, n.id).toBe(true);
    }
    sim.inject('esc80a', 'selfTestFail', true, 0b101);
    const st = await r.settle(r.dev('esc80a').selfTest());
    expect(st).toMatchObject({ passed: false, mask: 0b101 });
    expect(st.failed.map((b) => b.key)).toEqual(['gate_driver', 'voltage_sense']);
  });

  it('injected faults show up in faults.list; clearFaults clears the sticky bits', async () => {
    const sim = createScenario('all.devices');
    const r = await connect(sim);
    await r.discover();
    const esc = r.dev('esc80a');
    const node = sim.node('esc80a') as EscNode;
    sim.inject('esc80a', 'motorDisconnected');
    const loop = esc.control.start('duty', 0.2);
    await r.until(() => esc.faults.list.some((f) => f.key === 'motor_disconnected' && f.kind === 'active'), 2000, 'active fault');
    loop.stop();
    expect(esc.state).toBe(DeviceState.FAULT);
    expect(esc.faults.list.find((f) => f.key === 'motor_disconnected')?.label.tr).toBe('Motor bağlantısı yok');
    await r.until(() => esc.faults.list.some((f) => f.key === 'motor_disconnected' && f.kind === 'sticky'), 1000, 'sticky bit read');
    // The ESC latches this fault: it stays active after the cause is gone, until CLEAR_FAULTS.
    sim.inject('esc80a', 'motorDisconnected', false);
    await r.runFor(600);
    expect(esc.faults.active).not.toBe(0);
    await r.settle(esc.clearFaults());
    await r.until(() => esc.faults.active === 0 && esc.state !== DeviceState.FAULT, 2000, 'fault released');
    const f = await r.settle(esc.readFaults());
    expect(f.sticky).toBe(node.faults.sticky);
    expect(f.list.some((x) => x.key === 'motor_disconnected')).toBe(false);

    sim.inject('cyncoder', 'magnetMissing');
    const enc = r.dev('cyncoder');
    await r.until(() => enc.faults.list.some((x) => x.key === 'magnet_missing' && x.kind === 'active'), 2000, 'magnet fault');
    sim.inject('pdh_large', 'fuseBlown', true, 3);
    const pdh = r.dev('pdh_large');
    await r.until(() => pdh.faults.list.some((x) => x.key === 'fuse_blown'), 2000, 'fuse fault');
    sim.inject('sealed_servo', 'leak');
    const sv = r.dev('sealed_servo');
    await r.until(() => sv.faults.list.length > 0, 2000, 'leak fault');
    expect(sv.faults.list.map((x) => x.key)).toContain('water_leak');
  });
});
