import { getModel, paramByKey, PType } from '@cygnus/protocol';
import { applyPlan, fitName, getTemplate, planApply, planDevices, validateConfig, type SlotBinding, type VehicleConfig, type VehicleTemplate } from '@cygnus/vehicles';
import { describe, expect, it } from 'vitest';
import { createScenario } from '../../src/scenarios';
import type { Simulation } from '../../src/simulation';
import { connect, type Rig } from './harness';

/** The configuration a user would build in the wizard, from where the simulator placed each slot. */
function configFromPlacements(sim: Simulation, r: Rig, tpl: VehicleTemplate): VehicleConfig {
  const bindings: Record<string, SlotBinding> = {};
  for (const s of tpl.slots) {
    const p = sim.slotPlacements[s.id];
    if (!p) continue;
    const node = sim.node(p.nodeId);
    const uid48 = r.dev(p.nodeId).uid48;
    bindings[s.id] = p.channel !== undefined ? { kind: 'channel', uid48, model: node.def.key, channel: p.channel } : { kind: 'device', uid48, model: node.def.key };
  }
  return { templateId: tpl.id, name: tpl.name.tr, bindings };
}

async function setUp(id: string): Promise<{ sim: Simulation; r: Rig; tpl: VehicleTemplate; cfg: VehicleConfig }> {
  const tpl = getTemplate(id)!;
  const sim = createScenario(`vehicle.${id}`, { assigned: false });
  const r = await connect(sim);
  await r.until(() => r.bus.devices.filter((d) => d.online).length === sim.nodes.length, 3000, 'all factory-fresh boards');
  expect(r.bus.unresolved.length).toBe(sim.nodes.length);
  const cfg = configFromPlacements(sim, r, tpl);
  expect(validateConfig(tpl, cfg)).toEqual([]);
  return { sim, r, tpl, cfg };
}

async function applyAndCheck(sim: Simulation, r: Rig, tpl: VehicleTemplate, cfg: VehicleConfig): Promise<void> {
  const plan = planApply(tpl, cfg, planDevices(r.bus.devices));
  expect(plan.warnings.filter((w) => w.code !== 'nameShortened')).toEqual([]);
  const seen: number[] = [];
  const res = await r.settle(applyPlan(r.bus, plan, { onStep: (_s, i) => seen.push(i) }), 60_000);
  expect(res.results.filter((x) => !x.ok).map((x) => `${x.step.kind} ${x.error?.message}`)).toEqual([]);
  expect(res.ok).toBe(true);
  expect(seen.length).toBe(res.results.length);
  await r.runFor(1500);
  expect(r.bus.unresolved).toEqual([]);
  expect(sim.countUnresolved()).toBe(0);

  // Power-cycle everything: numbers, names and presets were saved on the boards.
  for (const n of sim.nodes) sim.powerCycle(n.id);
  await r.runFor(400);
  await r.discover(sim.nodes.length, 4000);
  const servoNames = new Set<string>();
  for (const s of tpl.slots) {
    const p = sim.slotPlacements[s.id];
    if (!p) continue;
    const node = sim.node(p.nodeId);
    const d = r.dev(p.nodeId);
    expect(d.online, s.id).toBe(true);
    expect(d.conflict || d.unassigned, s.id).toBe(false);
    if (p.channel === undefined) {
      if (s.suggestedNum !== undefined) expect(node.num, s.id).toBe(s.suggestedNum);
      else expect(node.num, s.id).toBeLessThan(63);
      expect(d.name, s.id).toBe(fitName(s.label.tr));
      const def = getModel(node.def.model)!;
      for (const [k, v] of Object.entries(s.presets ?? {})) {
        const pd = paramByKey(def, k);
        if (!pd) continue;
        const want = pd.ptype === PType.F32 ? Math.fround(v) : v;
        expect(node.params.getKey(k), `${s.id} ${k}`).toBe(want);
      }
    } else {
      servoNames.add(d.name);
      expect(node.params.getKey(`ch.${p.channel}.enable`), `${s.id} channel`).toBe(1);
    }
  }
  if (servoNames.size > 0) expect([...servoNames]).toEqual(['Servo kartı']);
}

describe('host ↔ simulator: vehicle configuration', () => {
  it('frc.swerve4 from factory-fresh boards; the steer motor holds position on its remote Cyncoder', async () => {
    const { sim, r, tpl, cfg } = await setUp('frc.swerve4');
    await applyAndCheck(sim, r, tpl, cfg);
    for (const g of ['fl', 'fr', 'bl', 'br']) {
      const steer = sim.node(`${g}.steer`);
      expect(steer.params.getKey('fb.source')).toBe(2);
      expect(steer.params.getKey('fb.remote_num')).toBe(sim.node(`${g}.enc`).num);
    }
    const steer = r.dev('fl.steer');
    const enc = r.dev('fl.enc');
    await r.runFor(100);
    const start = enc.getSignal('position');
    const target = start + 0.25;
    const loop = steer.control.start('position', target);
    await r.runFor(2000);
    expect(Math.abs(enc.getSignal('position') - target)).toBeLessThan(0.01);
    expect(Math.abs(steer.getSignal('position') - target)).toBeLessThan(0.01);
    // A shove on the module: the loop pulls it back.
    sim.world.push('fl.steer.shaft', 3, sim.timeMs, 100);
    await r.runFor(300);
    const pushedTo = enc.getSignal('position');
    await r.runFor(1500);
    // Stiction leaves a small band; the loop holds it near the target instead of where the shove left it.
    expect(Math.abs(enc.getSignal('position') - target)).toBeLessThan(0.02);
    expect(Math.abs(enc.getSignal('position') - target)).toBeLessThanOrEqual(Math.abs(pushedTo - target) + 1e-9);
    loop.stop();
  });

  it('underwater.rov8 from factory-fresh boards', async () => {
    const { sim, r, tpl, cfg } = await setUp('underwater.rov8');
    await applyAndCheck(sim, r, tpl, cfg);
    const power = sim.node('power');
    const soc = sim.node('soc');
    expect(power.def.devType).toBe(soc.def.devType);
    expect(power.num).not.toBe(soc.num);
  });
});
