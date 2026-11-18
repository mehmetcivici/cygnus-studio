import { BROADCAST_ALL, DevType, EscMode, Model, NUM_UNASSIGNED, crc32, encodeCtrlSet, encodeEnumReq, encodeStreamConfig, encodeStreamStart } from '@cygnus/protocol';
import { getTemplate } from '@cygnus/vehicles';
import { describe, expect, it } from 'vitest';
import type { EscNode } from '../src/devices/esc';
import { buildVehicleScenario, createScenario, ScenarioBuilder, scenarios } from '../src/scenarios';
import type { PowerDistributor } from '../src/simulation';
import { MOTORS } from '../src/world';
import { Host } from './helpers';

describe('scenarios', () => {
  it('lists the required scenarios with TR/EN names, plus vehicle ones', () => {
    const ids = scenarios.map((s) => s.id);
    for (const id of ['bench.flywheel', 'bench.arm', 'factory.fresh', 'all.devices', 'vehicle.frc.swerve4', 'vehicle.underwater.rov6']) expect(ids).toContain(id);
    for (const s of scenarios) expect(s.name.tr && s.name.en).toBeTruthy();
  });

  it.each(scenarios.map((s) => s.id))('%s builds and runs 5 s', (id) => {
    const sim = createScenario(id);
    const host = new Host(sim);
    host.run(5000);
    const snap = sim.snapshot();
    expect(snap.nodes.length).toBeGreaterThan(0);
    expect(snap.nodes.every((n) => n.powered)).toBe(true);
    if (id !== 'factory.fresh') {
      expect(snap.nodes.every((n) => n.num !== NUM_UNASSIGNED && !n.conflict)).toBe(true);
      expect(snap.nodes.filter((n) => n.faults.active !== 0).map((n) => n.id)).toEqual([]);
    }
    expect(host.of('heartbeat').length).toBeGreaterThan(0);
  });

  // host-sim #7 / test #5: every feed's load is what hangs on it right now, nothing piles up.
  it.each(scenarios.map((s) => s.id))('%s (servo channels where possible): power feeds stay consistent for 10 s', (id) => {
    const sim = createScenario(id, { useServoChannels: true });
    const w = sim.world;
    const distributors = sim.nodes.filter((n): n is typeof n & PowerDistributor => 'feeds' in n);
    for (let t = 0; t < 10; t++) {
      sim.advance(1000);
      for (const dist of distributors) {
        for (const f of dist.feeds) {
          let expected = 0;
          for (const n of sim.nodes) if (n.feed === f && n.mode !== 0) expected += n.supplyCurrent();
          for (const e of w.pwmEscs) if (e.feed === f) expected += e.supplyCurrent;
          // Loads are summed before the boards' step, so they lag by one ms: compare loosely.
          expect(Math.abs(f.load - expected)).toBeLessThan(0.05 + 0.05 * expected);
          expect(f.load).toBeLessThan(100);
        }
      }
      let top = 0;
      for (const n of sim.nodes) if (n.feed === w.battery.feed && n.mode !== 0) top += n.supplyCurrent();
      for (const e of w.pwmEscs) if (e.feed === w.battery.feed) top += e.supplyCurrent;
      expect(Math.abs(w.battery.feed.load - top)).toBeLessThan(0.05 + 0.05 * top);
    }
    expect(w.battery.feed.voltage).toBeGreaterThan(11);
    expect(sim.nodes.every((n) => n.mode !== 0)).toBe(true);
  });

  it('every model is present in all.devices', () => {
    const sim = createScenario('all.devices');
    const models = new Set(sim.nodes.map((n) => n.def.model));
    for (let m = 1; m <= 11; m++) expect(models.has(m)).toBe(true);
  });

  it('factory.fresh shows unassigned boards and a conflict pair', () => {
    const sim = createScenario('factory.fresh');
    const host = new Host(sim);
    host.run(2000);
    const r = host.ask(encodeEnumReq(BROADCAST_ALL, { filter: 1 }), 'enumRsp', 150);
    expect(r.filter((x) => x.num === NUM_UNASSIGNED).length).toBeGreaterThanOrEqual(5);
    expect(r.filter((x) => x.conflict).length).toBe(2);
  });

  it('swerve: steer motor and its encoder share a shaft; steer ESC listens to that encoder', () => {
    const sim = buildVehicleScenario(getTemplate('frc.swerve4')!);
    const p = sim.slotPlacements;
    expect(p['fl.steer']!.shaftId).toBe(p['fl.enc']!.shaftId);
    const steer = sim.node(p['fl.steer']!.nodeId) as EscNode;
    const enc = sim.node(p['fl.enc']!.nodeId);
    expect(steer.params.getKey('fb.source')).toBe(2);
    expect(steer.params.getKey('fb.remote_num')).toBe(enc.num);
    expect(sim.world.body.config.kind).toBe('swerve');
    // Each drive ESC sits behind a PDH channel.
    const drive = sim.node(p['fl.drive']!.nodeId);
    expect(drive.feed?.owner).toBe(sim.node('power'));
  });

  it('swerve: steering all modules tangentially and driving turns the robot', () => {
    const sim = buildVehicleScenario(getTemplate('frc.swerve4')!);
    const host = new Host(sim);
    host.run(4500); // gyro calibrates on boot
    const p = sim.slotPlacements;
    const tangent: Record<string, number> = { fl: 0.125, fr: 0.375, bl: -0.125, br: -0.375 };
    for (const g of Object.keys(tangent)) sim.world.shaft(p[`${g}.steer`]!.shaftId!).angle = tangent[g]! * 2 * Math.PI;
    for (const g of Object.keys(tangent)) host.arm({ devType: DevType.MOTOR_CONTROLLER, num: sim.node(p[`${g}.drive`]!.nodeId).num });
    for (let t = 0; t < 1000; t += 10) {
      for (const g of Object.keys(tangent)) {
        const num = sim.node(p[`${g}.drive`]!.nodeId).num;
        host.send(encodeCtrlSet({ devType: DevType.MOTOR_CONTROLLER, num }, { mode: EscMode.DUTY, flags: 0, value: 0.3 }));
      }
      host.run(10);
    }
    expect(Math.abs(sim.world.body.yawRate)).toBeGreaterThan(20);
    const gyro = sim.node(p['gyro']!.nodeId);
    expect(Math.abs(gyro.signalValues().yaw!)).toBeGreaterThan(5);
  });

  it('assigned: false gives factory-fresh boards without presets', () => {
    const sim = buildVehicleScenario(getTemplate('frc.swerve4')!, { assigned: false });
    sim.advance(500);
    expect(sim.nodes.every((n) => n.num === NUM_UNASSIGNED)).toBe(true);
    const steer = sim.node(sim.slotPlacements['fl.steer']!.nodeId) as EscNode;
    expect(steer.params.getKey('fb.source')).toBe(0);
  });

  it('multirotor: unequal thrust tilts the body slightly; ROV and boat turn on yaw torque', () => {
    const quad = buildVehicleScenario(getTemplate('air.quadx')!);
    const host = new Host(quad);
    host.run(400);
    const escs = quad.nodes.filter((n) => n.def.devType === DevType.MOTOR_CONTROLLER);
    for (const e of escs) host.arm({ devType: DevType.MOTOR_CONTROLLER, num: e.num });
    for (let t = 0; t < 1500; t += 10) {
      escs.forEach((e, i) => host.send(encodeCtrlSet({ devType: DevType.MOTOR_CONTROLLER, num: e.num }, { mode: EscMode.DUTY, flags: 0, value: i === 0 ? 0.9 : 0.8 })));
      host.run(10);
    }
    const b = quad.world.body;
    expect(b.airborne).toBe(true);
    expect(Math.abs(b.pitch) + Math.abs(b.roll)).toBeGreaterThan(0.5);
    expect(Math.abs(b.pitch) + Math.abs(b.roll)).toBeLessThan(40);

    const boat = buildVehicleScenario(getTemplate('surface.usv2')!);
    const h2 = new Host(boat);
    h2.run(400);
    const thr = boat.nodes.filter((n) => n.def.devType === DevType.MOTOR_CONTROLLER);
    h2.arm({ devType: DevType.MOTOR_CONTROLLER, num: thr[0]!.num });
    for (let t = 0; t < 1000; t += 10) {
      h2.send(encodeCtrlSet({ devType: DevType.MOTOR_CONTROLLER, num: thr[0]!.num }, { mode: EscMode.DUTY, flags: 0, value: 0.6 }));
      h2.run(10);
    }
    expect(Math.abs(boat.world.body.yawRate)).toBeGreaterThan(1);
  });

  it('servo-channel vehicles drive PWM ESCs through the servo board', () => {
    const sim = buildVehicleScenario(getTemplate('underwater.rov6')!, { useServoChannels: true });
    expect(sim.nodes.some((n) => n.def.model === Model.SERVO_16CH)).toBe(true);
    expect(sim.world.pwmEscs.length).toBe(6);
    expect(sim.slotPlacements['thr.h1']!.channel).toBeGreaterThan(0);
  });

  it('is deterministic: same seed, same frames', () => {
    const hash = (seed: number): number => {
      const sim = createScenario('vehicle.frc.swerve4', { seed });
      const host = new Host(sim);
      host.run(300);
      host.send(encodeEnumReq(BROADCAST_ALL, { filter: 0 }));
      host.arm({ devType: DevType.MOTOR_CONTROLLER, num: 1 });
      for (let t = 0; t < 1500; t += 10) {
        host.send(encodeCtrlSet({ devType: DevType.MOTOR_CONTROLLER, num: 1 }, { mode: EscMode.VELOCITY, flags: 0, value: 2000 }));
        host.run(10);
      }
      let h = 0;
      for (const r of host.rx) {
        const b = new Uint8Array(r.frame.data.length + 12);
        b.set(r.frame.data);
        new DataView(b.buffer).setUint32(r.frame.data.length, r.frame.id, true);
        new DataView(b.buffer).setFloat64(r.frame.data.length + 4, r.frame.timestamp, true);
        h = crc32(b) ^ Math.imul(h, 31);
      }
      return h >>> 0;
    };
    expect(hash(5)).toBe(hash(5));
    expect(hash(5)).not.toBe(hash(6));
  });

  it('runs a 25-board vehicle at least 5× faster than real time', () => {
    const sim = buildVehicleScenario(getTemplate('frc.swerve4')!, { seed: 2 });
    const b = new ScenarioBuilder(sim);
    const w = sim.world;
    for (let i = 0; i < 4; i++) {
      const j = w.addShaft({ id: `arm${i}`, inertia: 0.3, viscous: 0.05, coulomb: 0.3, gravity: { torqueNm: 6, downRot: 0 } });
      b.esc({ id: `arm${i}.esc`, model: Model.ESC_80A, motor: MOTORS.neo, shaft: j, gear: 60, num: 20 + i, params: { 'fb.source': 2, 'fb.remote_num': 20 + i } });
      b.encoder({ id: `arm${i}.enc`, shaft: j, num: 20 + i });
    }
    for (let i = 0; i < 2; i++) {
      const f = w.addShaft({ id: `shooter${i}`, inertia: 0.002, viscous: 1e-4, coulomb: 0.01 });
      b.esc({ id: `shooter${i}`, model: Model.ESC_80A, motor: MOTORS.neo, shaft: f, num: 30 + i, params: { 'fb.source': 1 } });
    }
    b.oled({ id: 'oled', num: 1 });
    expect(sim.nodes.length).toBe(25);
    const host = new Host(sim);
    host.run(500);
    const escNums = sim.nodes.filter((n) => n.def.devType === DevType.MOTOR_CONTROLLER).map((n) => n.num);
    host.send(encodeStreamConfig({ devType: DevType.MOTOR_CONTROLLER, num: 30 }, { slot: 0, sid: 5 }));
    host.send(encodeStreamStart({ devType: DevType.MOTOR_CONTROLLER, num: 30 }, { period100us: 10 }));
    for (const num of escNums) host.arm({ devType: DevType.MOTOR_CONTROLLER, num });
    const run = (ms: number): void => {
      for (let t = 0; t < ms; t += 20) {
        for (const num of escNums) host.send(encodeCtrlSet({ devType: DevType.MOTOR_CONTROLLER, num }, { mode: EscMode.DUTY, flags: 0, value: 0.2 }));
        if (t % 1000 === 0) host.send(encodeStreamStart({ devType: DevType.MOTOR_CONTROLLER, num: 30 }, { period100us: 10 }));
        sim.advance(20);
        host.clear();
      }
    };
    run(1000); // warm-up (JIT)
    const t0 = performance.now();
    run(10_000);
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(2000);
    expect(sim.nodes.every((n) => n.mode === 2)).toBe(true);
  });
});
