import { encodeCtrlSet, encodeAssignId, encodeParamSet, Model, PType, DevType, EscMode } from '@cygnus/protocol';
import { Simulation } from './src/simulation';
import { EscNode } from './src/devices/esc';
import { MOTORS } from './src/world';

const sim = new Simulation({ seed: 3 });
const fw = sim.world.addShaft({ id: 'fly', inertia: 0.004, viscous: 1e-4, coulomb: 0.02 });
const m = sim.world.addMotor(MOTORS.neo, fw, 1);
const esc = sim.addNode(new EscNode(Model.ESC_80A, { id: 'esc', num: 1, motor: m, params: { 'fb.source': 1 } }));
const t = sim.createTransport(); t.open();
const a = { devType: DevType.MOTOR_CONTROLLER, num: 1 };
sim.advance(400);
const kp = Number(process.argv[2] ?? 0.002), kv = Number(process.argv[3] ?? 0.0021);
t.send(encodeParamSet(a, { pid: 0x160, ptype: PType.F32, value: kp }));
t.send(encodeParamSet(a, { pid: 0x164, ptype: PType.F32, value: kv }));
sim.advance(10);
const t0 = performance.now();
for (let i = 0; i < 1500; i++) {
  t.send(encodeCtrlSet(a, { mode: EscMode.VELOCITY, flags: 0, value: 3000 }));
  sim.advance(1);
  if (i % 100 === 0) { const s = esc.signalValues(); console.log(i, s.velocity.toFixed(0), 'true', fw.rpm.toFixed(0), 'I', s['phase.current'].toFixed(1), 'V', s['loop.output'].toFixed(2), 'state', esc.state, esc.faults.active.toString(2)); }
}
console.log('ms', performance.now() - t0);
