import { CyncoderV3Driver, FaultBit, type DeviceHandle, type FrameDescription } from '@cygnus/protocol';
import { describe, expect, it } from 'vitest';
import type { EscNode } from '../../src/devices/esc';
import { createScenario } from '../../src/scenarios';
import { connect } from './harness';

describe('host ↔ simulator: connection life', () => {
  it('pulling a cable loses the board (control stops), plugging it back restores it', async () => {
    const sim = createScenario('all.devices');
    const r = await connect(sim);
    await r.discover();
    const d = r.dev('esc80a');
    const lost: DeviceHandle[] = [];
    r.bus.on('deviceLost', (x) => lost.push(x));
    const loop = d.control.start('duty', 0.2);
    await r.runFor(200);
    sim.setCable('esc80a', false);
    await r.until(() => !d.online, 2000, 'deviceLost');
    expect(lost).toEqual([d]);
    expect(loop.active).toBe(false);
    // The board itself timed out to neutral (no more CTRL frames reach it).
    expect((sim.node('esc80a') as EscNode).isEnabled()).toBe(false);
    expect(r.bus.devices.includes(d)).toBe(true);
    // Its number stays reserved while it is away.
    expect(r.bus.suggestNumber(d.devType)).toBe(3);
    expect(await r.caught(d.getParam('vel.kp'))).toMatchObject({ code: 'TIMEOUT' });

    sim.setCable('esc80a', true);
    await r.until(() => d.online && d.infoLoaded, 3000, 'board back');
    expect(r.bus.deviceByUid(d.uid48)).toBe(d);
    expect(await r.settle(d.getParam('ctrl.timeout_ms'))).toBe(200);
  });

  it('a shorted bus: every board is lost and flags CAN_ERR; the bus recovers when the short goes', async () => {
    const sim = createScenario('bench.arm');
    const r = await connect(sim);
    await r.discover();
    sim.setBusShort(true);
    await r.runFor(1700);
    expect(r.bus.devices.every((d) => !d.online)).toBe(true);
    for (const n of sim.nodes) expect(n.faults.active & (1 << FaultBit.CAN_ERR)).not.toBe(0);
    sim.setBusShort(false);
    await r.until(() => r.bus.devices.every((d) => d.online && d.infoLoaded), 3000, 'boards back');
    await r.runFor(600);
    for (const d of r.bus.devices) expect(d.faults.active & (1 << FaultBit.CAN_ERR)).toBe(0);
    expect(r.bus.devices.length).toBe(sim.nodes.length);
  });

  it('power-cycling a board while the host watches', async () => {
    const sim = createScenario('bench.arm');
    const r = await connect(sim);
    await r.discover();
    const d = r.dev('enc');
    sim.setPower('enc', false);
    await r.until(() => !d.online, 2000, 'lost');
    sim.setPower('enc', true);
    await r.until(() => d.online && d.infoLoaded, 3000, 'back');
    expect(d.num).toBe(1);
  });

  it('stopping the bus removes every device and rejects pending requests', async () => {
    const sim = createScenario('bench.flywheel');
    const r = await connect(sim);
    await r.discover();
    const d = r.dev('esc');
    const removed: DeviceHandle[] = [];
    r.bus.on('deviceRemoved', (x) => removed.push(x));
    const p = d.getParam('vel.kp');
    p.catch(() => undefined);
    await r.bus.stop();
    expect(await r.caught(p)).toMatchObject({ code: 'DISCONNECTED' });
    expect(r.bus.devices).toEqual([]);
    expect(removed.length).toBe(sim.nodes.length);
  });

  it('describeFrame decodes every frame of a busy session without throwing', async () => {
    const sim = createScenario('all.devices');
    const r = await connect(sim, { drivers: [new CyncoderV3Driver({ initialSequence: 1 })] });
    const rows: FrameDescription[] = [];
    let errors = 0;
    r.bus.on('frame', ({ frame }) => {
      try {
        rows.push(r.bus.describeFrame(frame, rows.length % 2 ? 'en' : 'tr'));
      } catch {
        errors++;
      }
    });
    await r.discover();
    const esc = r.dev('esc80a');
    const sub = esc.stream.open({ signals: ['velocity', 'duty'], periodUs: 1000 });
    const loop = esc.control.start('duty', 0.2);
    r.dev('servo16').control.send('channels_1_4', { pulsesUs: [1500, 1600, 0, 0] });
    r.dev('oled').control.send('text', { line: 0, col: 0, text: 'Merhaba' });
    await r.runFor(300);
    await r.settle(r.dev('gyro').readAllParams());
    await r.settle(r.dev('sealed_servo').selfTest());
    await r.settle(r.dev('pdh_large').readFaults());
    r.bus.estop();
    await r.runFor(50);
    loop.stop();
    sub.close();
    r.bus.identifyByUid(r.dev('cyncoder').uid48, 1);
    await r.settle(r.dev('cyncoder_v3').identify(1));
    await r.runFor(50);
    expect(errors).toBe(0);
    expect(rows.length).toBeGreaterThan(1000);
    const classes = new Set(rows.map((x) => x.className));
    for (const c of ['CTRL', 'STATUS', 'SYS_REQ', 'SYS_RSP', 'PARAM_REQ', 'PARAM_RSP', 'STREAM_REQ', 'STREAM_RSP', 'ENUM_RSP']) expect(classes.has(c), c).toBe(true);
    expect(new Set(rows.map((x) => x.protocol))).toEqual(new Set(['cycan', 'cyncoder-v3']));
    expect(rows.every((x) => x.summary.length > 0)).toBe(true);
  });
});
