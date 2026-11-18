import { Command, DeviceState, DevType, EscMode, FaultBit, Model, PType, encodeCommand, encodeCtrlSet, encodeParamSet, f32ToBits } from '@cygnus/protocol';
import { describe, expect, it } from 'vitest';
import { EscNode } from '../src/devices/esc';
import { createScenario } from '../src/scenarios';
import { Simulation } from '../src/simulation';
import { MOTORS } from '../src/world';
import { Host } from './helpers';

const A = { devType: DevType.MOTOR_CONTROLLER, num: 1 };
const PID = {
  velKp: 0x160, velKi: 0x161, velKd: 0x162, velKs: 0x163, velKv: 0x164, velIMax: 0x166, velFilter: 0x168,
  posKp: 0x180, posKi: 0x181, posKd: 0x182, posIMax: 0x183, cruise: 0x184, accel: 0x185,
  fwdEn: 0x127, fwdRot: 0x128, pwmEnable: 0x1c0,
};

function bench(id = 'bench.flywheel'): { sim: Simulation; host: Host; esc: EscNode } {
  const sim = createScenario(id);
  const host = new Host(sim);
  host.run(500);
  return { sim, host, esc: sim.node('esc') as EscNode };
}

function setF(host: Host, pid: number, value: number, ptype: number = PType.F32): void {
  host.send(encodeParamSet(A, { pid, ptype, value }));
  host.run(2);
}

/** Drives `mode`/`value` every 10 ms for `ms`, sampling signals each ms. */
function drive(host: Host, esc: EscNode, mode: number, value: number, ms: number): Array<Record<string, number>> {
  const out: Array<Record<string, number>> = [];
  host.arm(A);
  for (let t = 0; t < ms; t++) {
    if (t % 10 === 0) host.send(encodeCtrlSet(A, { mode, flags: 0, value }));
    host.run(1);
    out.push(esc.signalValues());
  }
  return out;
}

const sd = (a: number[]): number => {
  const m = a.reduce((x, y) => x + y, 0) / a.length;
  return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / a.length);
};

describe('ESC velocity loop', () => {
  it('settles on a velocity step with good gains', () => {
    const { host, esc } = bench();
    setF(host, PID.velKp, 0.003);
    setF(host, PID.velKi, 0.003);
    setF(host, PID.velIMax, 0.5);
    setF(host, PID.velKs, 0.05);
    setF(host, PID.velKv, 1 / 473);
    const s = drive(host, esc, EscMode.VELOCITY, 3000, 3000);
    const tail = s.slice(-500).map((x) => x.velocity!);
    const mean = tail.reduce((a, b) => a + b) / tail.length;
    expect(Math.abs(mean - 3000)).toBeLessThan(60);
    expect(sd(tail)).toBeLessThan(25);
    expect(sd(s.slice(-500).map((x) => x['loop.output']!))).toBeLessThan(1);
  });

  it('chatters with an excessive Kp behind a slow velocity filter', () => {
    const { host, esc } = bench();
    setF(host, PID.velKp, 1);
    setF(host, PID.velFilter, 10);
    setF(host, PID.velKv, 1 / 473);
    const s = drive(host, esc, EscMode.VELOCITY, 3000, 3000).slice(-1000);
    const out = s.map((x) => x['loop.output']!);
    expect(sd(out)).toBeGreaterThan(4);
    let flips = 0;
    for (let i = 1; i < out.length; i++) if (Math.sign(out[i]! - 7) !== Math.sign(out[i - 1]! - 7)) flips++;
    expect(flips).toBeGreaterThan(10);
  });

  it('respects the phase and supply current limits', () => {
    const { host, esc } = bench();
    const s = drive(host, esc, EscMode.DUTY, 1, 400);
    const maxPhase = Math.max(...s.map((x) => Math.abs(x['phase.current']!)));
    const maxSupply = Math.max(...s.map((x) => x['bus.current']!));
    expect(maxPhase).toBeLessThan(100 * 1.12);
    expect(maxPhase).toBeGreaterThan(60);
    expect(maxSupply).toBeLessThan(60 * 1.12);
  });

  it('tracks a current target', () => {
    const { host, esc, sim } = bench();
    sim.world.setJammed('flywheel', true);
    const s = drive(host, esc, EscMode.CURRENT, 15, 300);
    const tail = s.slice(-100).map((x) => x['phase.current']!);
    expect(Math.abs(tail.reduce((a, b) => a + b) / tail.length - 15)).toBeLessThan(1);
  });

  it('brake stops a spinning flywheel faster than coast (idle mode)', () => {
    const spinDown = (mode: number): number => {
      const { host, esc, sim } = bench();
      if (mode === EscMode.OFF) setF(host, 0x103, 1, PType.ENUM);
      drive(host, esc, EscMode.DUTY, 0.5, 1500);
      const v0 = sim.world.shaft('flywheel').rpm;
      drive(host, esc, mode, 0, 300);
      return sim.world.shaft('flywheel').rpm / v0;
    };
    expect(spinDown(EscMode.BRAKE)).toBeLessThan(spinDown(EscMode.OFF) * 0.9);
  });
});

describe('ESC position loop (bench.arm)', () => {
  it('follows a trapezoidal profile and holds the arm against gravity', () => {
    const { host, esc } = bench('bench.arm');
    setF(host, PID.posKp, 40);
    setF(host, PID.posKi, 20);
    setF(host, PID.posKd, 1);
    setF(host, PID.posIMax, 4);
    setF(host, PID.cruise, 30);
    setF(host, PID.accel, 60);
    const s = drive(host, esc, EscMode.POSITION, 0.25, 4000);
    const refs = s.map((x) => x.setpoint!);
    // The reference ramps (profile), it does not jump.
    expect(refs[100]!).toBeLessThan(0.05);
    const refVel = refs.slice(1).map((r, i) => (r - refs[i]!) * 60000);
    expect(Math.max(...refVel)).toBeLessThan(30.5);
    expect(Math.max(...refVel)).toBeGreaterThan(29);
    const tail = s.slice(-500).map((x) => x.position!);
    for (const p of tail) expect(Math.abs(p - 0.25)).toBeLessThan(0.015);
    expect(sd(tail)).toBeLessThan(0.002);
  });

  it('remote encoder loss is a fault and drops closed-loop drive; driving again needs a neutral first', () => {
    const { host, esc, sim } = bench('bench.arm');
    drive(host, esc, EscMode.POSITION, 0.1, 200);
    sim.setCable('enc', false);
    drive(host, esc, EscMode.POSITION, 0.1, 200);
    expect(esc.faults.active & (1 << 13)).not.toBe(0);
    // An active fault forces neutral and refuses CTRL (PROTOCOL §7).
    expect(esc.isEnabled()).toBe(false);
    expect(esc.state).toBe(DeviceState.FAULT);
    expect(esc.signalValues()['loop.output']).toBe(0);
    sim.setCable('enc', true);
    for (let t = 0; t < 200; t += 10) {
      host.send(encodeCtrlSet(A, { mode: EscMode.POSITION, flags: 0, value: 0.1 }));
      host.run(10);
    }
    expect(esc.faults.active).toBe(0);
    expect(esc.isEnabled()).toBe(false); // the stale target does not come back by itself
    drive(host, esc, EscMode.POSITION, 0.1, 50);
    expect(esc.isEnabled()).toBe(true);
  });
});

describe('ESC sensing and supply (host-sim #13, #14)', () => {
  it('the hall position starts at 0 wherever the rotor stands at power-up', () => {
    const sim = createScenario('bench.flywheel');
    sim.world.shaft('flywheel').angle = 2.7; // rad
    const host = new Host(sim);
    host.run(500);
    const esc = sim.node('esc') as EscNode;
    expect(Math.abs(esc.signalValues().position!)).toBeLessThan(0.03);
  });

  it('bridge losses are drawn from the supply as well', () => {
    const { host, esc, sim } = bench();
    sim.world.setJammed('flywheel', true);
    const s = drive(host, esc, EscMode.CURRENT, 40, 400).slice(-200);
    const mean = (k: string) => s.reduce((a, x) => a + x[k]!, 0) / s.length;
    const motorOnly = Math.abs(mean('phase.current') * mean('duty')) + 0.06;
    const i = Math.abs(mean('phase.current'));
    const vbus = mean('bus.voltage');
    const conduction = (2 * i * i * 0.0016) / vbus;
    expect(mean('bus.current') - motorOnly).toBeGreaterThan(0.8 * conduction);
  });
});

describe('ESC protections and inputs', () => {
  it('soft limit blocks driving past the forward limit', () => {
    const { host, esc } = bench();
    setF(host, PID.fwdEn, 1, PType.BOOL);
    setF(host, PID.fwdRot, 20);
    drive(host, esc, EscMode.DUTY, 0.2, 3000);
    const p = esc.signalValues().position!;
    expect(p).toBeGreaterThan(19.9);
    expect(esc.signalValues()['duty']).toBeCloseTo(0, 2);
  });

  it('locked rotor latches until CLEAR_FAULTS', () => {
    const { host, esc, sim } = bench();
    sim.inject('esc', 'jam', true);
    drive(host, esc, EscMode.DUTY, 0.8, 1800);
    expect(esc.faults.active & (1 << 12)).not.toBe(0);
    expect(Math.abs(esc.signalValues()['phase.current']!)).toBeLessThan(1);
    sim.inject('esc', 'jam', false);
    host.send(encodeCommand(A, { cmd: Command.CLEAR_FAULTS, arg: 0 }));
    host.run(5);
    expect(esc.faults.active & (1 << 12)).toBe(0);
  });

  it('overheats under an injected heat source and cuts output', () => {
    const { host, esc, sim } = bench();
    sim.inject('esc', 'overtemp', true);
    host.run(20000);
    expect(esc.faults.active & (1 << FaultBit.OVERTEMP)).not.toBe(0);
    expect(esc.fetTemperature).toBeGreaterThan(99);
    drive(host, esc, EscMode.DUTY, 0.5, 100);
    expect(Math.abs(esc.signalValues()['phase.current']!)).toBeLessThan(1);
  });

  it('flags undervoltage when the battery sags below the cutoff', () => {
    const { host, esc, sim } = bench();
    sim.setBatteryVoltage(5.8);
    host.run(50);
    expect(esc.faults.active & (1 << FaultBit.UNDERVOLT)).not.toBe(0);
    sim.setBatteryVoltage(12.8);
    host.run(50);
    expect(esc.faults.active & (1 << FaultBit.UNDERVOLT)).toBe(0);
  });

  it('a disconnected motor is detected', () => {
    const { host, esc, sim } = bench();
    sim.inject('esc', 'motorDisconnected', true);
    drive(host, esc, EscMode.DUTY, 0.3, 300);
    expect(esc.faults.active & (1 << 10)).not.toBe(0);
  });

  it('PWM input drives the motor when no CAN command is present', () => {
    const { host, esc, sim } = bench();
    setF(host, PID.pwmEnable, 1, PType.BOOL);
    esc.pwmIn.pulseUs = 1750;
    host.run(1500);
    expect(esc.isEnabled()).toBe(true);
    expect(sim.world.shaft('flywheel').rpm).toBeGreaterThan(1000);
    esc.pwmIn.pulseUs = 0;
    host.run(10);
    expect(esc.isEnabled()).toBe(false);
  });
});

describe('ESC actions', () => {
  it('detect direction fixes an inverted hall wiring', () => {
    const sim = new Simulation({ seed: 3 });
    const sh = sim.world.addShaft({ id: 's', inertia: 0.002, viscous: 1e-4, coulomb: 0.01 });
    const m = sim.world.addMotor(MOTORS.neo, sh, 1);
    m.hallInverted = true;
    const esc = sim.addNode(new EscNode(Model.ESC_80A, { id: 'esc', num: 1, motor: m, params: { 'fb.source': 1 } }));
    const host = new Host(sim);
    host.run(400);
    const r = host.ask(encodeCommand(A, { cmd: 0x40, arg: 0 }), 'commandRsp', 700);
    expect(r.map((x) => x.status)).toEqual([1, 0]);
    expect(r[1]!.result).toBe(1);
    expect(esc.params.getKey('fb.sensor_invert')).toBe(1);
  });

  it('measures motor resistance, inductance and kV', () => {
    const { host, esc } = bench();
    const r = host.ask(encodeCommand(A, { cmd: 0x41, arg: 0 }), 'commandRsp', 1400);
    expect(r.map((x) => x.status)).toEqual([1, 0]);
    expect(esc.params.getKey('motor.kv_rpm_per_v')).toBeGreaterThan(473 * 0.95);
    expect(esc.params.getKey('motor.kv_rpm_per_v')).toBeLessThan(473 * 1.05);
    expect(esc.params.getKey('motor.resistance_ohm')).toBeCloseTo(0.114, 1);
  });

  it('a neutral CTRL cancels a running moving action with FAILED (PROTOCOL §4.5)', () => {
    const { host, esc } = bench();
    const r = host.ask(encodeCommand(A, { cmd: 0x41, arg: 0 }), 'commandRsp', 600);
    expect(r.map((x) => x.status)).toEqual([1]);
    expect(Math.abs(esc.signalValues().velocity!)).toBeGreaterThan(100);
    const kv = esc.params.getKey('motor.kv_rpm_per_v');
    const cut = host.ask(encodeCtrlSet(A, { mode: EscMode.OFF, flags: 0, value: 0 }), 'commandRsp', 2);
    expect(cut.map((x) => [x.cmd, x.status])).toEqual([[0x41, 5]]);
    host.clear();
    host.run(1200);
    // No late OK, the motor coasts down, nothing was written.
    expect(host.of('commandRsp')).toEqual([]);
    expect(esc.isEnabled()).toBe(false);
    expect(Math.abs(esc.signalValues()['motor.voltage'] ?? 0)).toBeLessThan(0.01);
    expect(esc.params.getKey('motor.kv_rpm_per_v')).toBe(kv);
  });

  it('the CTRL timeout ends a moving action with FAILED instead of leaving it hung', () => {
    const { host, esc } = bench();
    host.arm(A); // watchdog running
    host.run(5);
    const r = host.ask(encodeCommand(A, { cmd: 0x40, arg: 0 }), 'commandRsp', 400);
    expect(r.map((x) => x.status)).toEqual([1, 5]);
    expect(esc.isEnabled()).toBe(false);
    // Nothing left pending: the next command runs.
    expect(host.ask(encodeCommand(A, { cmd: 0x43, arg: 0 }), 'commandRsp', 2)[0]!.status).toBe(0);
  });

  it('the self test is not cancelled by neutral CTRL', () => {
    const { host } = bench();
    host.arm(A);
    host.run(5);
    const r = host.ask(encodeCommand(A, { cmd: Command.SELF_TEST, arg: 0 }), 'commandRsp', 5);
    expect(r[0]!.status).toBe(1);
    host.clear();
    host.arm(A);
    host.run(2);
    expect(host.of('commandRsp')).toEqual([]);
  });

  it('set position re-zeroes the reported position', () => {
    const { host, esc } = bench();
    drive(host, esc, EscMode.DUTY, 0.3, 500);
    host.send(encodeCommand(A, { cmd: 0x43, arg: f32ToBits(5) }));
    host.run(2);
    expect(esc.signalValues().position).toBeCloseTo(5, 0);
  });
});
