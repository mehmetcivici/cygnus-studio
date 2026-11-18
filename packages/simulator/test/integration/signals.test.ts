import { describe, expect, it } from 'vitest';
import { createScenario } from '../../src/scenarios';
import { connect, cycanNodes } from './harness';

describe('host ↔ simulator: STATUS signals', () => {
  it.each([[true], [false]])('decoded STATUS signals match the simulator, every model (fd=%s)', async (fd) => {
    const sim = createScenario('all.devices', { fd });
    const r = await connect(sim);
    await r.discover();
    // Something moving: flywheel spinning, servo holding a position.
    const esc = r.dev('esc80a');
    const loop = esc.control.start('duty', 0.3);
    await r.runFor(400);
    // Simulator truth per millisecond: a STATUS frame is up to one period old when read.
    const history: Array<Map<string, Record<string, number>>> = [];
    for (let t = 0; t < 1100; t++) {
      await r.runFor(1);
      history.push(new Map(cycanNodes(sim).map((n) => [n.id, n.signalValues()])));
    }
    const snap = sim.snapshot();
    let compared = 0;
    for (const n of snap.nodes.filter((x) => x.modelKey !== 'cyncoder_v3')) {
      const node = sim.node(n.id);
      const d = r.dev(n.id);
      for (const frame of node.def.statusFrames) {
        for (const field of frame.fields) {
          const sig = node.def.signals.find((s) => s.key === field.signal)!;
          const host = d.signals[field.signal];
          let truth = n.signals[field.signal]!;
          for (const h of history) {
            const v = h.get(n.id)![field.signal]!;
            if (Math.abs(v - (host ?? NaN)) < Math.abs(truth - (host ?? NaN))) truth = v;
          }
          expect(Number.isNaN(host), `${n.id} ${field.signal} never arrived`).toBe(false);
          const span = sig.range[1] - sig.range[0];
          const lsb = field.type === 'f32' ? 0 : (field.scale ?? 1);
          const tol = Math.max(2 * lsb, 0.03 * span, 1e-6);
          // The frame on the wire is up to one period old; saturating fields clamp to their range.
          const lo = Math.min(sig.range[0], truth);
          const hi = Math.max(sig.range[1], truth);
          expect(Math.abs((host ?? NaN) - Math.min(hi, Math.max(lo, truth))), `${n.id} ${field.signal}: host ${host} sim ${truth}`).toBeLessThanOrEqual(tol);
          compared++;
        }
      }
    }
    expect(compared).toBeGreaterThan(40);
    loop.stop();
  });

  it('onSignals delivers updates with the frame keys', async () => {
    const sim = createScenario('bench.flywheel');
    const r = await connect(sim);
    await r.discover();
    const d = r.dev('esc');
    const seen = new Set<string>();
    let calls = 0;
    const off = d.onSignals((u) => {
      calls++;
      for (const k of u.keys) seen.add(k);
    });
    await r.runFor(500);
    off();
    expect(calls).toBeGreaterThan(20);
    expect(seen.has('velocity')).toBe(true);
    expect(d.getSignal('bus.voltage')).toBeCloseTo(sim.snapshot().nodes[0]!.signals['bus.voltage']!, 0);
  });
});
