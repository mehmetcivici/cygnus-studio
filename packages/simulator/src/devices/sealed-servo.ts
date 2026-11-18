import { CommandStatus, FaultBit, Model, SealedServoMode, readF32 } from '@cygnus/protocol';
import { CtrlResult, NodeMode, SimNode, type InjectionKind, type SimNodeOptions } from '../node';
import { MOTORS, clamp, type Motor, type MotorDriver, type Shaft } from '../world';

const SIGNAL_KEYS = [
  'position',
  'velocity',
  'setpoint',
  'error',
  'current',
  'voltage',
  'temp',
  'output',
  'ctrl.mode',
] as const;
const S_POSITION = 0;
const S_VELOCITY = 1;
const S_SETPOINT = 2;
const S_ERROR = 3;
const S_CURRENT = 4;
const S_VOLTAGE = 5;
const S_TEMP = 6;
const S_OUTPUT = 7;
const S_CTRL_MODE = 8;

// Parameter slots, resolved to table indices once per board.
const PARAM_KEYS = [
  'pos.kp',
  'pos.ki',
  'pos.kd',
  'pos.i_max',
  'pos.tolerance_deg',
  'motion.max_speed_dps',
  'motion.max_accel_dps2',
  'motion.zero_offset_deg',
  'motion.invert',
  'motion.continuous',
  'motion.idle_mode',
  'limits.current_a',
  'limits.min_angle_deg',
  'limits.max_angle_deg',
  'limits.temp_c',
] as const;
const P_POS_KP = 0;
const P_POS_KI = 1;
const P_POS_KD = 2;
const P_POS_I_MAX = 3;
const P_POS_TOLERANCE_DEG = 4;
const P_MOTION_MAX_SPEED_DPS = 5;
const P_MOTION_MAX_ACCEL_DPS2 = 6;
const P_MOTION_ZERO_OFFSET_DEG = 7;
const P_MOTION_INVERT = 8;
const P_MOTION_CONTINUOUS = 9;
const P_MOTION_IDLE_MODE = 10;
const P_LIMITS_CURRENT_A = 11;
const P_LIMITS_MIN_ANGLE_DEG = 12;
const P_LIMITS_MAX_ANGLE_DEG = 13;
const P_LIMITS_TEMP_C = 14;

const F = { STALL: 10, WATER_LEAK: 11 } as const;
const GEAR = 300;

export interface SealedServoOptions extends SimNodeOptions {
  /** Output shaft (e.g. an arm joint); the simulation creates a lightly loaded one when omitted. */
  shaft?: Shaft | null;
}

/**
 * Sealed CAN servo: geared DC motor (300:1) with an absolute output sensor, profiled position
 * loop in duty units, current (torque) limit, stall and leak detection.
 */
export class SealedServoNode extends SimNode implements MotorDriver {
  shaft: Shaft | null;
  motor: Motor | null = null;
  private ctrlMode: number = SealedServoMode.OFF;
  private setpoint = 0;
  private duty = 0;
  private coast = true;
  private profP = 0;
  private profV = 0;
  private integ = 0;
  private pos = 0;
  private vel = 0;
  private readonly posHist = new Float64Array(10);
  private velHead = 0;
  private stallMs = 0;
  private stalled = false;
  private stallSetpoint = 0;
  private leak = false;
  private extraHeatW = 0;
  private boardTemp = 25;
  private readonly P: Int32Array;
  private readonly S: Int32Array;

  constructor(o: SealedServoOptions = {}) {
    super(Model.SEALED_SERVO, o);
    this.shaft = o.shaft ?? null;
    this.P = Int32Array.from(PARAM_KEYS, (k) => this.params.index(k));
    this.S = Int32Array.from(SIGNAL_KEYS, (k) => this.sigIndex(k));
  }

  private pk(i: number): number {
    return this.p(this.P[i]!);
  }

  protected override onAttach(): void {
    const w = this.ctx.world;
    if (!this.shaft) this.shaft = w.addShaft({ id: `${this.id}.out`, label: `${this.id} output`, inertia: 2e-4, viscous: 0.002, coulomb: 0.05 });
    this.motor = w.addMotor(MOTORS.servoCore, this.shaft, GEAR);
    this.motor.driver = this;
    this.boardTemp = w.ambientC;
  }

  /** Output angle, degrees, after zero and direction. */
  private readAngle(): number {
    const raw = (this.shaft ? this.shaft.rot * 360 : 0) + this.rng.gauss() * 0.03;
    const dir = this.pk(P_MOTION_INVERT) ? -1 : 1;
    return dir * (raw - this.pk(P_MOTION_ZERO_OFFSET_DEG));
  }

  protected override onAppStart(): void {
    this.ctrlMode = SealedServoMode.OFF;
    this.pos = this.readAngle();
    this.posHist.fill(this.pos);
    this.profP = this.pos;
    this.profV = 0;
    this.integ = 0;
    this.stalled = false;
  }

  protected override onAppStop(): void {
    this.ctrlMode = SealedServoMode.OFF;
    this.duty = 0;
    this.coast = true;
  }

  protected override onCtrl(index: number, d: Uint8Array, len: number, armed: boolean): CtrlResult {
    if (index !== 0 || len < 8) return CtrlResult.INVALID;
    const mode = d[0] ?? 0;
    const v = readF32(d, 4);
    if (mode > SealedServoMode.DUTY || !Number.isFinite(v)) return CtrlResult.INVALID;
    const r = mode === SealedServoMode.OFF && v === 0 ? CtrlResult.NEUTRAL : CtrlResult.DRIVE;
    if (r === CtrlResult.DRIVE && !armed) return r;
    if (mode !== this.ctrlMode) {
      this.ctrlMode = mode;
      this.integ = 0;
      this.profP = this.pos;
      this.profV = this.vel;
    }
    if (this.stalled && Math.abs(v - this.stallSetpoint) > this.pk(P_POS_TOLERANCE_DEG)) this.stalled = false;
    this.setpoint = v;
    return r;
  }

  protected override neutral(): void {
    this.ctrlMode = SealedServoMode.OFF;
    this.integ = 0;
  }

  override isEnabled(): boolean {
    return this.mode === NodeMode.APP && this.commandable && this.ctrlMode !== SealedServoMode.OFF && !this.estopped;
  }

  drive(m: Motor, _sub: number): void {
    if (this.mode !== NodeMode.APP || this.coast) {
      m.coast = this.mode !== NodeMode.APP || this.pk(P_MOTION_IDLE_MODE) === 1;
      m.voltage = 0;
      if (!m.coast) this.limit(m, 0);
      return;
    }
    const dir = this.pk(P_MOTION_INVERT) ? -1 : 1;
    m.coast = false;
    this.limit(m, dir * this.duty * this.supplyV);
  }

  /** Current (torque) limit by bounding the voltage around the back-EMF. */
  private limit(m: Motor, v: number): void {
    const ilim = this.pk(P_LIMITS_CURRENT_A);
    const e = m.ke * m.omega;
    const r = m.spec.resistance;
    m.voltage = clamp(clamp(v, e - r * ilim, e + r * ilim), -this.supplyV, this.supplyV);
  }

  protected override appTick(): void {
    const dt = 0.001;
    const m = this.motor;
    this.pos = this.readAngle();
    // Velocity over a 10 ms window keeps sensor noise from swamping slow motion.
    const k = this.velHead;
    const rawVel = (this.pos - this.posHist[k]!) / 0.01;
    this.posHist[k] = this.pos;
    this.velHead = (k + 1) % 10;
    this.vel += (rawVel - this.vel) * 0.2;
    const tol = this.pk(P_POS_TOLERANCE_DEG);
    const hot = (m ? m.tempC : 25) > this.pk(P_LIMITS_TEMP_C);
    this.setFault(FaultBit.OVERTEMP, hot);
    this.setFault(F.WATER_LEAK, this.leak);
    let err = 0;
    let ref = this.setpoint;
    this.coast = false;
    if (!this.commandable || hot || this.stalled || this.estopped || this.supplyV < 5) {
      this.duty = 0;
      this.coast = this.pk(P_MOTION_IDLE_MODE) === 1 || this.estopped;
      ref = this.pos;
    } else {
      switch (this.ctrlMode) {
        case SealedServoMode.OFF:
          this.duty = 0;
          this.coast = this.pk(P_MOTION_IDLE_MODE) === 1;
          ref = this.pos;
          break;
        case SealedServoMode.DUTY:
          this.duty = clamp(this.setpoint, -1, 1);
          break;
        case SealedServoMode.VELOCITY: {
          const target = clamp(this.setpoint, -this.pk(P_MOTION_MAX_SPEED_DPS), this.pk(P_MOTION_MAX_SPEED_DPS));
          const free = this.freeSpeedDps();
          err = target - this.vel;
          this.integ = clamp(this.integ + err * 0.002 * dt, -0.3, 0.3);
          this.duty = clamp(target / free + 0.004 * err + this.integ, -1, 1);
          break;
        }
        case SealedServoMode.POSITION: {
          let goal = this.setpoint;
          if (!this.pk(P_MOTION_CONTINUOUS)) goal = clamp(goal, this.pk(P_LIMITS_MIN_ANGLE_DEG), this.pk(P_LIMITS_MAX_ANGLE_DEG));
          this.profile(goal, dt);
          ref = this.profP;
          err = this.profP - this.pos;
          this.integ = clamp(this.integ + this.pk(P_POS_KI) * err * dt, -this.pk(P_POS_I_MAX), this.pk(P_POS_I_MAX));
          const u = this.pk(P_POS_KP) * err + this.integ + this.pk(P_POS_KD) * (this.profV - this.vel) + this.profV / this.freeSpeedDps();
          this.duty = clamp(u, -1, 1);
          break;
        }
      }
    }
    // Stall: pushing hard, not moving, not where it should be.
    const iAbs = m ? Math.abs(m.current) : 0;
    if (this.isEnabled() && iAbs > 0.8 * this.pk(P_LIMITS_CURRENT_A) && Math.abs(this.vel) < 5 && Math.abs(this.setpoint - this.pos) > tol) this.stallMs++;
    else this.stallMs = Math.max(0, this.stallMs - 20); // leaky, so a noise spike does not reset it
    if (this.stallMs > 1000 && !this.stalled) {
      this.stalled = true;
      this.stallSetpoint = this.setpoint;
    }
    this.setFault(F.STALL, this.stalled);
    this.boardTemp += (30 + iAbs * 3 + this.extraHeatW / 2 - this.boardTemp) * 0.0005;
    if (m && this.extraHeatW > 0) m.tempC += (this.extraHeatW / m.spec.thermalC) * dt;
    const s = this.sig;
    const S = this.S;
    s[S[S_POSITION]!] = this.pos;
    s[S[S_VELOCITY]!] = this.vel;
    s[S[S_SETPOINT]!] = ref;
    s[S[S_ERROR]!] = this.ctrlMode === SealedServoMode.OFF ? 0 : err;
    s[S[S_CURRENT]!] = (m ? m.current : 0) * (this.pk(P_MOTION_INVERT) ? -1 : 1) + this.rng.gauss() * 0.005;
    s[S[S_VOLTAGE]!] = this.supplyV;
    s[S[S_TEMP]!] = Math.max(this.boardTemp, m ? m.tempC : 0);
    s[S[S_OUTPUT]!] = this.duty;
    s[S[S_CTRL_MODE]!] = this.ctrlMode;
  }

  private freeSpeedDps(): number {
    return ((MOTORS.servoCore.kv * Math.max(6, this.supplyV)) / GEAR) * 6;
  }

  private profile(goal: number, dt: number): void {
    const vmax = this.pk(P_MOTION_MAX_SPEED_DPS);
    const a = this.pk(P_MOTION_MAX_ACCEL_DPS2) || 1e9;
    const dist = goal - this.profP;
    if (Math.abs(dist) < 1e-6 && Math.abs(this.profV) < a * dt) {
      this.profP = goal;
      this.profV = 0;
      return;
    }
    const dirn = Math.sign(dist) || -Math.sign(this.profV);
    const stop = (this.profV * this.profV) / (2 * a);
    const target = Math.sign(this.profV) === dirn && stop >= Math.abs(dist) ? 0 : dirn * vmax;
    this.profV += clamp(target - this.profV, -a * dt, a * dt);
    let np = this.profP + this.profV * dt;
    if ((goal - np) * dirn < 0) {
      np = goal;
      this.profV = 0;
    }
    this.profP = np;
  }

  override supplyCurrent(): number {
    if (this.mode === NodeMode.OFF) return 0;
    const m = this.motor;
    const v = this.supplyV;
    return 0.03 + (m && !m.coast && v > 1 ? Math.max(0, (m.current * m.voltage) / v) : 0);
  }

  protected override onClearFaults(): void {
    this.stalled = false;
    this.stallMs = 0;
  }

  protected override action(cmd: number): { status: number; result: number } {
    if (cmd !== 0x40) return { status: CommandStatus.UNSUPPORTED, result: 0 };
    const raw = this.shaft ? this.shaft.rot * 360 : 0;
    this.params.setKey('motion.zero_offset_deg', ((raw + 180) % 360 + 360) % 360 - 180);
    this.pos = this.readAngle();
    this.profP = this.pos;
    return { status: CommandStatus.OK, result: 0 };
  }

  override supportedInjections(): InjectionKind[] {
    return ['leak', 'jam', 'overtemp'];
  }

  protected override injectModel(kind: InjectionKind, on: boolean): boolean {
    switch (kind) {
      case 'leak':
        this.leak = on;
        return true;
      case 'jam':
        if (this.shaft) this.shaft.jammed = on;
        return true;
      case 'overtemp':
        this.extraHeatW = on ? 40 : 0;
        return true;
    }
    return false;
  }

  protected override activeModelInjections(): InjectionKind[] {
    const out: InjectionKind[] = [];
    if (this.leak) out.push('leak');
    if (this.shaft?.jammed) out.push('jam');
    if (this.extraHeatW > 0) out.push('overtemp');
    return out;
  }
}

