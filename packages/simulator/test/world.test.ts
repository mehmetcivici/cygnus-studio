import { describe, expect, it } from 'vitest';
import { Prng } from '../src/prng';
import { Simulation } from '../src/simulation';
import { MOTORS, World } from '../src/world';

function step(w: World, ms: number, t0 = 0): void {
  for (let t = 0; t < ms; t++) {
    for (let s = 0; s < 10; s++) w.substep(s);
    w.finishStep(t0 + t + 1);
  }
}

describe('World', () => {
  it('a gravity arm swings down and settles; hard stops hold it', () => {
    const w = new World(new Prng(1));
    const arm = w.addShaft({ id: 'a', inertia: 0.1, viscous: 0.2, coulomb: 0.05, gravity: { torqueNm: 5, downRot: 0 }, initialRot: 0.2 });
    step(w, 5000);
    expect(Math.abs(arm.rot)).toBeLessThan(0.01);
    const b = w.addShaft({ id: 'b', inertia: 0.1, gravity: { torqueNm: 5, downRot: 0 }, initialRot: 0.2, stops: { minRot: 0.1, maxRot: 0.3 } });
    step(w, 2000);
    expect(b.rot).toBeGreaterThanOrEqual(0.1 - 1e-9);
  });

  it('stiction holds a shaft until the torque breaks it free', () => {
    const w = new World(new Prng(1));
    const s = w.addShaft({ id: 's', inertia: 0.01, coulomb: 0.5, stiction: 0.6 });
    s.load = 0.55;
    step(w, 100);
    expect(s.omega).toBe(0);
    s.load = 0.7;
    step(w, 100);
    expect(s.omega).toBeGreaterThan(0);
  });

  it('propeller drag grows with the square of speed', () => {
    const w = new World(new Prng(1));
    const p = w.addShaft({ id: 'p', inertia: 1e-4, prop: { kT: 1e-5, kQ: 1e-6 } });
    p.load = 0.04;
    step(w, 3000);
    // Terminal speed where kQ·ω² = load.
    expect(p.omega).toBeCloseTo(Math.sqrt(0.04 / 1e-6), -1);
    expect(p.thrust).toBeCloseTo(1e-5 * p.omega * p.omega, 6);
  });

  it('motor current follows (V − back-EMF)/R and gearing multiplies torque', () => {
    const w = new World(new Prng(1));
    const s = w.addShaft({ id: 's', inertia: 1 });
    const m = w.addMotor(MOTORS.neo, s, 10);
    s.jammed = true;
    m.driver = { drive: (mm) => ((mm.coast = false), (mm.voltage = 1.14)) };
    step(w, 20);
    expect(m.current).toBeCloseTo(10, 1);
    s.jammed = false;
    step(w, 1);
    expect(s.netTorque).toBeGreaterThan(m.ke * 9 * 10);
  });

  it('the battery sags with load and recovers', () => {
    const sim = new Simulation({ seed: 1 });
    const b = sim.world.battery;
    b.update(100, 0.001);
    for (let i = 0; i < 20; i++) b.update(100, 0.001);
    expect(b.feed.voltage).toBeCloseTo(b.ocv - 1.5, 1);
    for (let i = 0; i < 20; i++) b.update(0, 0.001);
    expect(b.feed.voltage).toBeCloseTo(b.ocv, 2);
  });

  it('hand moves turn a shaft by the requested amount and stop', () => {
    const w = new World(new Prng(1));
    const s = w.addShaft({ id: 's', inertia: 0.01 });
    w.handRotate('s', 0.25, 0, 500);
    step(w, 800);
    expect(s.rot).toBeCloseTo(0.25, 3);
    expect(s.omega).toBe(0);
  });
});
