import { NUM_UNASSIGNED, getModel } from '@cygnus/protocol';
import { describe, expect, it } from 'vitest';
import { createScenario, scenarios } from '../../src/scenarios';
import { connect, cycanNodes } from './harness';

describe('host ↔ simulator: discovery', () => {
  it.each(scenarios.filter((s) => s.id !== 'factory.fresh').map((s) => [s.id] as const))('%s: every board is found with model, name, version and INFO', async (id) => {
    const sim = createScenario(id);
    const r = await connect(sim);
    const nodes = cycanNodes(sim);
    await r.discover(nodes.length, 4000);
    expect(r.bus.devices.length).toBe(nodes.length);
    for (const n of nodes) {
      const d = r.dev(n.id);
      expect(d.online).toBe(true);
      expect(d.model).toBe(n.def.model);
      expect(d.def).toBe(getModel(n.def.model));
      expect(d.devType).toBe(n.def.devType);
      expect(d.num).toBe(n.num);
      expect(d.conflict).toBe(false);
      expect(d.name).toBe(n.nameText);
      expect(d.fw).toEqual(n.firmware);
      expect(d.hwRev).toBe(n.hwRev);
      expect(d.catalogRev).toBe(n.def.catalogRev);
      expect(d.catalogStatus).toBe('ok');
      expect(d.uid96).toBe(Array.from(n.uid96, (b) => b.toString(16).padStart(2, '0')).join(''));
      expect(d.build).not.toBeNull();
    }
    expect(r.bus.unresolved).toEqual([]);
    expect(r.bus.currentStats.requestTimeouts).toBe(0);
  });

  it('factory.fresh: unassigned boards and the #1 encoder pair show up as unresolved', async () => {
    const sim = createScenario('factory.fresh');
    const r = await connect(sim);
    await r.until(() => r.bus.devices.length === sim.nodes.length, 3000, 'all boards');
    await r.runFor(1500);
    const unresolved = new Set(r.bus.unresolved.map((d) => d.uid48));
    for (const n of sim.nodes) {
      const d = r.dev(n.id);
      if (n.id === 'pdh') expect(unresolved.has(d.uid48)).toBe(false);
      else expect(unresolved.has(d.uid48)).toBe(true);
      if (n.num === NUM_UNASSIGNED) expect(d.unassigned).toBe(true);
    }
    expect(sim.node('enc-a').conflict && sim.node('enc-b').conflict).toBe(true);
  });
});
