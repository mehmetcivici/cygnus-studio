import { describe, expect, it } from 'vitest';
import { getTemplate } from '../src';

// Expected layouts from ArduPilot libraries/AP_Motors/AP_MotorsMatrix.cpp (master).
// Motor number = index in the MotorDef array + 1 (add_motors passes the index); the third
// field of each entry is the motor-test order, not the motor number. Angle: 0 = nose,
// clockwise positive. AP_MOTORS_MATRIX_YAW_FACTOR_CW = -1 / _CCW = +1 (AP_MotorsMatrix.h)
// and match the propeller directions in the ArduPilot Copter motor-order diagrams.
type Spin = 'cw' | 'ccw';
const LAYOUTS: Record<string, { fn: string; frame: string; motors: [number, number, Spin][] }> = {
  'air.quadx': {
    fn: 'setup_quad_matrix', frame: 'MOTOR_FRAME_TYPE_X',
    motors: [[1, 45, 'ccw'], [2, -135, 'ccw'], [3, -45, 'cw'], [4, 135, 'cw']],
  },
  'air.quadplus': {
    fn: 'setup_quad_matrix', frame: 'MOTOR_FRAME_TYPE_PLUS',
    motors: [[1, 90, 'ccw'], [2, -90, 'ccw'], [3, 0, 'cw'], [4, 180, 'cw']],
  },
  'air.hexax': {
    fn: 'setup_hexa_matrix', frame: 'MOTOR_FRAME_TYPE_X',
    motors: [[1, 90, 'cw'], [2, -90, 'ccw'], [3, -30, 'cw'], [4, 150, 'ccw'], [5, 30, 'ccw'], [6, -150, 'cw']],
  },
  'air.octox': {
    fn: 'setup_octa_matrix', frame: 'MOTOR_FRAME_TYPE_X',
    motors: [[1, 22.5, 'cw'], [2, -157.5, 'cw'], [3, 67.5, 'ccw'], [4, 157.5, 'ccw'], [5, -22.5, 'ccw'], [6, -112.5, 'ccw'], [7, -67.5, 'cw'], [8, 112.5, 'cw']],
  },
};

const bearing = ({ x, y }: { x: number; y: number }): number => (Math.atan2(x, y) * 180) / Math.PI;
const angleDiff = (a: number, b: number): number => Math.abs(((a - b + 540) % 360) - 180);

describe('ArduPilot multirotor motor layouts', () => {
  for (const [id, { fn, frame, motors }] of Object.entries(LAYOUTS)) {
    it(`${id} matches ${fn} ${frame}`, () => {
      const tpl = getTemplate(id);
      if (!tpl) throw new Error(id);
      const props = tpl.slots.filter((s) => s.role === 'propeller');
      expect(props).toHaveLength(motors.length);
      for (const [n, deg, spin] of motors) {
        const s = props.find((p) => p.suggestedNum === n);
        if (!s) throw new Error(`${id} motor ${n} missing`);
        expect(angleDiff(bearing(s.pos), deg), `${id} motor ${n} angle`).toBeLessThanOrEqual(1);
        expect(s.spin, `${id} motor ${n} spin`).toBe(spin);
      }
    });
  }
});
