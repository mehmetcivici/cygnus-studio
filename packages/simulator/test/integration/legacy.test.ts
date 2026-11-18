import { CYNCODER_V3_MODEL, CyncoderV3Driver, Model, V3Command, V3Health, type CyncoderV3Device } from '@cygnus/protocol';
import { describe, expect, it } from 'vitest';
import type { LegacyCyncoderNode } from '../../src/devices/legacy-cyncoder';
import { createScenario } from '../../src/scenarios';
import { connect } from './harness';

async function legacyRig() {
  const sim = createScenario('legacy.cyncoder');
  const legacy = new CyncoderV3Driver({ initialSequence: 7 });
  const r = await connect(sim, { drivers: [legacy] });
  await r.discover();
  return { sim, r, legacy };
}

describe('host ↔ simulator: legacy Cyncoder v3 next to CyCAN', () => {
  it('one bus, two drivers: both kinds of board are found', async () => {
    const { sim, r } = await legacyRig();
    expect(sim.bus.fd).toBe(false);
    const devs = r.bus.devices;
    expect(devs.length).toBe(3);
    expect(devs.filter((d) => d.driver === 'cyncoder-v3').length).toBe(2);
    const cy = r.dev('cycan');
    expect(cy.driver).toBe('cycan');
    expect(cy.model).toBe(Model.CYNCODER);
    expect(cy.infoLoaded).toBe(true);
    const a = r.dev('v3-a') as CyncoderV3Device;
    const b = r.dev('v3-b') as CyncoderV3Device;
    expect(a.model).toBe(CYNCODER_V3_MODEL);
    expect([a.num, b.num]).toEqual([1, 2]);
    expect(a.uid32).toBe((sim.node('v3-a') as LegacyCyncoderNode).uid32);
    expect(a.conflict || b.conflict).toBe(false);
    await r.runFor(100);
    expect(a.getSignal('magnet.health')).toBe(V3Health.GOOD);
    expect(a.getSignal('protocol.version')).toBe(3);
    expect(Number.isNaN(a.getSignal('position'))).toBe(false);
    // Legacy handles keep their reduced capabilities.
    expect(await r.caught(a.getParam('enc.invert'))).toMatchObject({ code: 'NOT_SUPPORTED' });
    // The CyCAN board is unaffected by the legacy traffic (no conflicts, no timeouts).
    expect(r.bus.unresolved).toEqual([]);
    expect(r.bus.currentStats.requestTimeouts).toBe(0);
  });

  it('telemetry follows the shaft; zero, LED and factory default work over the v3 protocol', async () => {
    const { sim, r } = await legacyRig();
    const node = sim.node('v3-a') as LegacyCyncoderNode;
    const a = r.dev('v3-a');
    const shaft = 'shaft-a';
    const before = a.getSignal('position');
    sim.world.handRotate(shaft, 0.5, sim.timeMs, 300);
    await r.runFor(500);
    expect(a.getSignal('position') - before).toBeCloseTo(0.5, 1);

    const z = await r.settle(a.command('zero_here'));
    expect(z).toMatchObject({ confirmed: true });
    await r.runFor(50);
    expect(Math.abs(a.getSignal('position'))).toBeLessThan(0.01);
    expect(node.applied.map((x) => x.index)).toEqual([V3Command.SET_ZERO]);

    await r.settle(a.identify(5));
    expect(node.blinking).toBe(true);
    expect(sim.snapshot().nodes.find((n) => n.id === 'v3-a')?.identify).toBe(true);

    sim.world.handRotate(shaft, 0.25, sim.timeMs, 200);
    await r.runFor(400);
    await r.settle(a.command('factory_default'));
    expect(node.params.getKey('enc.zero_offset_rot')).toBe(0);
    // Only the addressed board (by UID) obeyed.
    expect((sim.node('v3-b') as LegacyCyncoderNode).applied).toEqual([]);
  });

  it('two legacy boards on one number: readings are withheld, commands still reach the right board', async () => {
    const { sim, r } = await legacyRig();
    const b = sim.node('v3-b');
    b.setFlashNum(1);
    sim.powerCycle('v3-b');
    const da = r.dev('v3-a');
    const db = r.dev('v3-b');
    await r.until(() => db.num === 1 && da.conflict && db.conflict, 2000, 'shared number seen');
    expect(Number.isNaN(da.getSignal('position'))).toBe(true);
    await r.settle(db.command('blink'));
    expect((b as LegacyCyncoderNode).blinking).toBe(true);
    expect((sim.node('v3-a') as LegacyCyncoderNode).blinking).toBe(false);
  });

  it('a sensor fault reports SENSOR_FAULT health', async () => {
    const { sim, r } = await legacyRig();
    sim.inject('v3-a', 'hardware');
    const a = r.dev('v3-a');
    await r.until(() => a.getSignal('magnet.health') === V3Health.SENSOR_FAULT, 1000, 'sensor fault');
  });
});
