import { Model, NUM_UNASSIGNED } from '@cygnus/protocol';
import { describe, expect, it } from 'vitest';
import { EscNode } from '../../src/devices/esc';
import { createScenario } from '../../src/scenarios';
import { MOTORS } from '../../src/world';
import { connect } from './harness';

function numbersUnique(nodes: ReadonlyArray<{ def: { devType: number }; num: number }>): boolean {
  const seen = new Set<string>();
  for (const n of nodes) {
    const k = `${n.def.devType}:${n.num}`;
    if (seen.has(k)) return false;
    seen.add(k);
  }
  return true;
}

describe('host ↔ simulator: conflict resolution', () => {
  it('factory.fresh: planResolve/resolveAll leave no unresolved board and unique numbers', async () => {
    const sim = createScenario('factory.fresh');
    const r = await connect(sim);
    await r.until(() => r.bus.devices.length === sim.nodes.length, 3000, 'all boards');
    await r.runFor(1200);
    const encA = sim.node('enc-a');
    const encB = sim.node('enc-b');
    const keeper = encA.uid48 < encB.uid48 ? encA : encB;

    const plan = r.bus.planResolve();
    expect(plan.length).toBe(sim.nodes.length - 1);
    const keepStep = plan[plan.length - 1]!;
    expect(keepStep).toMatchObject({ uid48: r.dev(keeper.id).uid48, from: 1, to: 1 });
    for (const s of plan.slice(0, -1)) expect(s.to).not.toBeNull();
    // Encoders: the keeper holds #1, the other two take #2 and #3.
    expect(plan.filter((s) => s.devType === 7).map((s) => s.to).sort()).toEqual([1, 2, 3]);

    const out = await r.settle(r.bus.resolveAll({ persist: true }), 10_000);
    expect(out.map((o) => (o.ok ? 'ok' : `${o.uid48}: ${o.error?.message}`))).toEqual(out.map(() => 'ok'));
    await r.runFor(2500);
    expect(r.bus.unresolved).toEqual([]);
    expect(sim.countUnresolved()).toBe(0);
    expect(numbersUnique(sim.nodes)).toBe(true);
    expect(keeper.num).toBe(1);
    for (const n of sim.nodes) {
      const d = r.dev(n.id);
      expect(d.num).toBe(n.num);
      expect(d.online).toBe(true);
      expect(d.conflict).toBe(false);
    }
    // persist: the numbers survive a power cycle.
    for (const n of sim.nodes) sim.powerCycle(n.id);
    await r.runFor(2500);
    expect(sim.countUnresolved()).toBe(0);
    expect(r.bus.unresolved).toEqual([]);
  });

  it('hot-plugging a board with a taken number: both fall silent, the host resolves it', async () => {
    const sim = createScenario('all.devices');
    const r = await connect(sim);
    await r.discover();
    const old = sim.node('esc80a');
    const shaft = sim.world.addShaft({ id: 'extra', inertia: 0.002, viscous: 1e-4, coulomb: 0.02 });
    const extra = sim.addNode(new EscNode(Model.ESC_80A, { id: 'extra-esc', num: old.num, uid96: sim.rng.bytes(12), motor: sim.world.addMotor(MOTORS.neo, shaft, 1) }));
    await r.until(() => old.conflict && extra.conflict, 2000, 'both boards in CONFLICT');
    await r.until(() => r.bus.unresolved.length === 2, 3000, 'host sees the conflict');
    expect(r.bus.unresolved.map((d) => d.uid48).sort()).toEqual([r.dev(old.id).uid48, r.dev(extra.id).uid48].sort());
    const plan = r.bus.planResolve();
    const keeper = old.uid48 < extra.uid48 ? old : extra;
    const mover = keeper === old ? extra : old;
    expect(plan.map((s) => s.uid48)).toEqual([r.dev(mover.id).uid48, r.dev(keeper.id).uid48]);
    expect(plan[0]!.to).toBe(3); // ESCs hold #1 and #2
    const out = await r.settle(r.bus.resolveAll());
    expect(out.every((o) => o.ok)).toBe(true);
    await r.runFor(2000);
    expect(r.bus.unresolved).toEqual([]);
    expect(keeper.num).toBe(2);
    expect(mover.num).toBe(3);
    expect(old.conflict || extra.conflict).toBe(false);
    expect(r.dev(mover.id).infoLoaded).toBe(true);
  });

  it('assignId refuses a taken number unless forced; unassigned boards blink by UID', async () => {
    const sim = createScenario('factory.fresh');
    const r = await connect(sim);
    await r.until(() => r.bus.devices.length === sim.nodes.length, 3000, 'all boards');
    const esc = r.dev('esc-a');
    expect(esc.unassigned).toBe(true);
    expect(sim.node('esc-a').num).toBe(NUM_UNASSIGNED);
    r.bus.identifyByUid(esc.uid48, 3);
    await r.runFor(20);
    expect(sim.snapshot().nodes.find((n) => n.id === 'esc-a')?.identify).toBe(true);
    await r.settle(r.bus.assignId(esc.uid48, 4));
    await r.until(() => esc.infoLoaded, 2000, 'INFO after assign');
    const other = r.dev('esc-b');
    expect(await r.caught(r.bus.assignId(other.uid48, 4))).toMatchObject({ code: 'INVALID', reason: 'number_taken' });
  });
});
