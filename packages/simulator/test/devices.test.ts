import {
  Command,
  CommandStatus,
  DevType,
  EscMode,
  FaultBit,
  GyroCalStatus,
  MagnetStatus,
  Model,
  PType,
  SealedServoMode,
  encodeCommand,
  encodeCtrlServo,
  encodeCtrlSet,
  encodeCtrlText,
  encodeInfoReq,
  encodeParamSet,
} from '@cygnus/protocol';
import { describe, expect, it } from 'vitest';
import { CyncoderNode } from '../src/devices/cyncoder';
import type { EscNode } from '../src/devices/esc';
import { GyroNode } from '../src/devices/gyro';
import { OledNode } from '../src/devices/oled';
import type { PdhLargeNode, PdhSmallNode, SocRegNode } from '../src/devices/power';
import type { SealedServoNode } from '../src/devices/sealed-servo';
import { Servo16Node } from '../src/devices/servo16';
import { createScenario } from '../src/scenarios';
import { Simulation } from '../src/simulation';
import { HobbyServo } from '../src/world';
import { Host } from './helpers';

function all(): { sim: Simulation; host: Host } {
  const sim = createScenario('all.devices');
  const host = new Host(sim);
  host.run(500);
  return { sim, host };
}

describe('Cyncoder', () => {
  it('reads the shaft angle, counts turns, reports velocity; zero here aligns it', () => {
    const sim = new Simulation({ seed: 1 });
    const shaft = sim.world.addShaft({ id: 's', inertia: 0.01 });
    const enc = sim.addNode(new CyncoderNode({ id: 'e', num: 1, shaft, mountRot: 0.3 }));
    const host = new Host(sim);
    host.run(400);
    expect(enc.signalValues()['abs.position']).toBeCloseTo(0.3, 2);
    sim.world.handTurn('s', 120, sim.timeMs, 1500); // 3 turns
    host.run(1000);
    expect(enc.signalValues().velocity).toBeCloseTo(120, -1);
    host.run(600);
    expect(enc.signalValues().position).toBeCloseTo(3.3, 1); // 3 turns + magnet mount angle
    host.send(encodeCommand({ devType: DevType.ENCODER, num: 1 }, { cmd: 0x40, arg: 0 }));
    host.run(2);
    expect(Math.abs(enc.signalValues().position!)).toBeLessThan(0.002);
    expect(enc.signalValues()['abs.position']).toBeLessThan(0.002);
  });

  it('magnet conditions map to status, AGC and faults', () => {
    const sim = new Simulation({ seed: 1 });
    const enc = sim.addNode(new CyncoderNode({ id: 'e', num: 1 }));
    sim.advance(400);
    expect(enc.signalValues()['magnet.status']).toBe(MagnetStatus.OK);
    sim.inject('e', 'magnetMissing');
    sim.advance(2);
    expect(enc.signalValues()['magnet.status']).toBe(MagnetStatus.MISSING);
    expect(enc.faults.active & (1 << 10)).not.toBe(0);
    sim.inject('e', 'magnetWeak');
    sim.advance(2);
    expect(enc.signalValues()['magnet.status']).toBe(MagnetStatus.WEAK);
    expect(enc.faults.warn & (1 << 11)).not.toBe(0);
  });
});

describe('Gyro', () => {
  it('drifts with an uncalibrated bias and stops drifting after calibration', () => {
    const sim = new Simulation({ seed: 8 });
    const g = sim.addNode(new GyroNode({ id: 'g', num: 1, params: { 'fusion.cal_on_boot': 0 }, biasDps: 0.5 }));
    const host = new Host(sim);
    host.run(10_400);
    const drift = Math.abs(g.signalValues().yaw!);
    expect(drift).toBeGreaterThan(Math.abs(g.trueBias[2]!) * 10 * 0.5);
    const r = host.ask(encodeCommand({ devType: DevType.GYRO, num: 1 }, { cmd: 0x40, arg: 0 }), 'commandRsp', 4100);
    expect(r.map((x) => x.status)).toEqual([CommandStatus.IN_PROGRESS, CommandStatus.OK]);
    const y0 = g.signalValues().yaw!;
    host.run(10_000);
    expect(Math.abs(g.signalValues().yaw! - y0)).toBeLessThan(0.5);
    expect(g.signalValues()['cal.status']).toBe(GyroCalStatus.DONE);
  });

  it('follows chassis rotation and fails calibration when moved', () => {
    const sim = new Simulation({ seed: 8 });
    const g = sim.addNode(new GyroNode({ id: 'g', num: 1, params: { 'fusion.cal_on_boot': 0 }, biasDps: 0 }));
    const host = new Host(sim);
    host.run(400);
    sim.world.spinBody(90, sim.timeMs, 1000);
    host.run(1200);
    expect(g.signalValues().yaw).toBeCloseTo(90, -1);
    sim.world.tiltBody(10, -5);
    host.run(5);
    expect(g.signalValues().pitch).toBeCloseTo(10, 0);
    expect(g.signalValues()['accel.x']).toBeCloseTo(Math.sin((10 * Math.PI) / 180), 1);
    host.send(encodeCommand({ devType: DevType.GYRO, num: 1 }, { cmd: 0x40, arg: 0 }));
    host.run(100);
    sim.world.spinBody(30, sim.timeMs, 500);
    host.run(4500);
    expect(g.signalValues()['cal.status']).toBe(GyroCalStatus.FAILED_MOTION);
    expect(g.faults.active & (1 << 10)).not.toBe(0);
  });
});

describe('Servo16', () => {
  it('limits, inverts, slews, fails safe and loads the rail', () => {
    const sim = new Simulation({ seed: 1 });
    const servo = new HobbyServo();
    const b = sim.addNode(
      new Servo16Node({ id: 's', num: 1, params: { 'ch.2.invert': 1, 'ch.3.speed_us_s': 1000, 'ch.1.failsafe_us': 1100 }, sinks: { 1: { kind: 'servo', servo } } }),
    );
    const host = new Host(sim);
    host.run(400);
    const A = { devType: DevType.SERVO_CONTROLLER, num: 1 };
    host.arm(A, 0);
    for (let t = 0; t < 300; t += 20) {
      host.send(encodeCtrlServo(A, { index: 0, pulsesUs: [2500, 1700, 2000, 0] }));
      host.run(20);
    }
    expect(b.pulse(1)).toBe(2000); // clamped to max
    expect(b.pulse(2)).toBe(1300); // mirrored around 1500
    expect(b.pulse(3)).toBe(2000);
    expect(b.pulse(4)).toBe(0);
    expect(servo.angleDeg).toBeGreaterThan(80);
    expect(b.signalValues()['rail.voltage']).toBeGreaterThan(5.5);
    host.send(encodeCtrlServo(A, { index: 0, pulsesUs: [2000, 1700, 1000, 0] }));
    host.run(100);
    expect(b.pulse(3)).toBeGreaterThan(1850); // 1000 µs/s slew: only ~100 µs in 100 ms
    host.run(300);
    expect(b.pulse(1)).toBe(1100); // CTRL timeout → failsafe
    expect(b.faults.warn & (1 << FaultBit.CTRL_TIMEOUT)).not.toBe(0);
    sim.inject('s', 'railOvercurrent');
    host.run(5);
    expect(b.faults.active & (1 << 10)).not.toBe(0);
    expect(b.signalValues()['rail.voltage']).toBeLessThan(0.5);
  });
});

describe('Sealed servo', () => {
  it('moves to a position at its speed limit, stalls when jammed, reports leaks', () => {
    const { host, sim } = all();
    const s = sim.node('sealed_servo') as SealedServoNode;
    const A = { devType: DevType.SERVO_CONTROLLER, num: 2 };
    host.arm(A);
    const cmd = (deg: number, ms: number) => {
      for (let t = 0; t < ms; t += 10) {
        host.send(encodeCtrlSet(A, { mode: SealedServoMode.POSITION, flags: 0, value: deg }));
        host.run(10);
      }
    };
    cmd(90, 200);
    const mid = s.signalValues().position!;
    expect(mid).toBeGreaterThan(20);
    expect(mid).toBeLessThan(75); // 360 °/s profile
    cmd(90, 1000);
    // P-only default gains leave a gravity offset of a few degrees.
    expect(Math.abs(s.signalValues().position! - 90)).toBeLessThan(6);
    cmd(500, 200);
    expect(s.signalValues().setpoint).toBeLessThanOrEqual(135.01); // angle limit
    sim.inject('sealed_servo', 'jam');
    cmd(0, 1500);
    expect(s.faults.active & (1 << 10)).not.toBe(0);
    sim.inject('sealed_servo', 'leak');
    host.run(2);
    expect(s.faults.active & (1 << 11)).not.toBe(0);
  });
});

describe('Power boards', () => {
  it('large PDH measures channel currents, blows fuses and counts energy', () => {
    const { host, sim } = all();
    const pdh = sim.node('pdh_large') as PdhLargeNode;
    const esc = sim.node('esc80a') as EscNode;
    const A = { devType: DevType.MOTOR_CONTROLLER, num: 2 };
    host.arm(A);
    for (let t = 0; t < 400; t += 10) {
      host.send(encodeCtrlSet(A, { mode: EscMode.DUTY, flags: 0, value: 0.6 }));
      host.run(10);
    }
    const ch2 = pdh.signalValues()['ch.2.current']!;
    expect(ch2).toBeCloseTo(esc.supplyCurrent(), -0.5);
    expect(ch2).toBeGreaterThan(5);
    expect(pdh.signalValues().energy).toBeGreaterThan(0);
    sim.inject('pdh_large', 'fuseBlown', true, 2);
    host.run(10);
    expect(pdh.signalValues()['fuse.mask']).toBe(2);
    expect(pdh.faults.active & (1 << 10)).not.toBe(0);
    expect(esc.mode).toBe(0); // the board behind the fuse lost power
    pdh.replaceFuse(2);
    host.run(600);
    expect(esc.mode).toBe(2);
    expect(host.ask(encodeCommand({ devType: DevType.POWER_DISTRIBUTION, num: 1 }, { cmd: 0x40, arg: 0 }), 'commandRsp')[0]!.status).toBe(0);
  });

  it('a fuse blows on sustained overload', () => {
    const { sim, host } = all();
    const pdh = sim.node('pdh_large') as PdhLargeNode;
    pdh.fuses[1]!.ratingA = 6;
    sim.world.setJammed('flywheel', true);
    host.arm({ devType: DevType.MOTOR_CONTROLLER, num: 2 });
    for (let t = 0; t < 3000 && pdh.signalValues()['fuse.mask'] === 0; t += 10) {
      host.send(encodeCtrlSet({ devType: DevType.MOTOR_CONTROLLER, num: 2 }, { mode: EscMode.CURRENT, flags: 0, value: 40 }));
      host.run(10);
    }
    expect(pdh.signalValues()['fuse.mask']).toBe(2);
  });

  it('small PDH and SoC regulator report rails, brownouts and regulation', () => {
    const { sim, host } = all();
    const small = sim.node('pdh_small') as PdhSmallNode;
    expect(small.signalValues()['rail5.voltage']).toBeCloseTo(5, 0);
    const soc = sim.node('soc_reg') as SocRegNode;
    expect(soc.signalValues()['output.voltage']).toBeCloseTo(12, 0);
    expect(soc.signalValues()['output.ripple']).toBeGreaterThan(10);
    sim.setBatteryVoltage(6);
    host.run(20);
    sim.setBatteryVoltage(12.8);
    host.run(20);
    expect(soc.brownoutCount).toBe(1);
    sim.inject('soc_reg', 'outputOvercurrent');
    host.run(5);
    expect(soc.faults.active & (1 << 10)).not.toBe(0);
  });
});

describe('Debug OLED', () => {
  it('draws CTRL text into the framebuffer and shows watch slots', () => {
    const { sim, host } = all();
    const oled = sim.node('oled') as OledNode;
    const A = { devType: DevType.MISC, num: 1 };
    host.send(encodeCtrlText(A, { line: 0, col: 0, text: 'CYGNUS' }));
    host.run(150);
    expect(oled.textLines()[0]).toBe('CYGNUS');
    expect(oled.currentPage).toBe('text');
    // 'C' first column is 0x3e: rows 1..5 lit, row 0 dark.
    expect(oled.pixel(0, 0)).toBe(false);
    expect(oled.pixel(0, 1)).toBe(true);
    let lit = 0;
    for (let i = 0; i < oled.framebuffer.length; i++) lit += oled.framebuffer[i] ? 1 : 0;
    expect(lit).toBeGreaterThan(20);
    host.send(encodeParamSet(A, { pid: 0x102, ptype: PType.F32, value: 1 }));
    host.run(1200);
    expect(['watch', 'overview']).toContain(oled.currentPage);
    expect(oled.signalValues()['bus.devices']).toBeGreaterThan(5);
  });

  it('USB-CAN adapter identifies itself', () => {
    const { host } = all();
    const r = host.ask(encodeInfoReq({ devType: DevType.MISC, num: 2 }, { page: 0 }), 'infoRsp')[0]!;
    expect(r.section === 'device' && r.model === Model.USB_CAN).toBe(true);
    void Command;
  });
});
