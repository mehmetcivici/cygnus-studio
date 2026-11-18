import { CyncoderV3Driver } from '@cygnus/protocol';
import { detectMovedEncoder, detectTiltedGyro } from '@cygnus/vehicles';
import { describe, expect, it } from 'vitest';
import { GyroNode } from '../../src/devices/gyro';
import { createScenario } from '../../src/scenarios';
import { Body } from '../../src/world';
import { connect } from './harness';

describe('host ↔ simulator: "turn it and it is found"', () => {
  it('finds the swerve encoder whose module is turned by hand', async () => {
    const sim = createScenario('vehicle.frc.swerve4');
    const r = await connect(sim);
    await r.discover();
    await r.runFor(200);
    const p = detectMovedEncoder(r.bus, { timeoutMs: 5000, minDeltaRot: 0.1 });
    await r.runFor(300);
    const placement = sim.slotPlacements['br.enc']!;
    sim.world.handRotate(placement.shaftId!, 0.3, sim.timeMs, 400);
    const found = await r.settle(p, 5000);
    expect(found?.device).toBe(r.dev(placement.nodeId));
    expect(found!.delta).toBeGreaterThanOrEqual(0.1);
  });

  it('also finds a legacy Cyncoder v3', async () => {
    const sim = createScenario('all.devices');
    const r = await connect(sim, { drivers: [new CyncoderV3Driver({ initialSequence: 1 })] });
    await r.discover();
    await r.runFor(100);
    const p = detectMovedEncoder(r.bus, { timeoutMs: 3000 });
    sim.world.handRotate('small', -0.5, sim.timeMs, 300);
    const found = await r.settle(p, 3000);
    expect(found?.device).toBe(r.dev('cyncoder_v3'));
  });

  it('resolves null when nothing moves, and rejects when aborted', async () => {
    const sim = createScenario('bench.arm');
    const r = await connect(sim);
    await r.discover();
    expect(await r.settle(detectMovedEncoder(r.bus, { timeoutMs: 1000 }), 2000)).toBeNull();
    const listeners = new Set<() => void>();
    const signal = { aborted: false, addEventListener: (_t: 'abort', l: () => void) => listeners.add(l), removeEventListener: (_t: 'abort', l: () => void) => listeners.delete(l) };
    const p = detectMovedEncoder(r.bus, { signal });
    await r.runFor(50);
    signal.aborted = true;
    for (const l of listeners) l();
    expect(await r.caught(p)).toMatchObject({ code: 'ABORTED' });
  });

  it('finds the gyro that is tilted, not the one lying on the bench', async () => {
    const sim = createScenario('all.devices');
    const loose = sim.addNode(new GyroNode({ id: 'gyro-loose', num: 2, uid96: sim.rng.bytes(12), body: new Body() }));
    const r = await connect(sim);
    await r.discover();
    await r.runFor(300);
    expect(r.dev(loose.id).online).toBe(true);
    const p = detectTiltedGyro(r.bus, { timeoutMs: 3000, minTiltDeg: 10 });
    await r.runFor(100);
    sim.world.tiltBody(0, 25);
    const found = await r.settle(p, 3000);
    expect(found?.device).toBe(r.dev('gyro'));
  });
});
