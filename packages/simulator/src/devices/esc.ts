import { Cls, CommandStatus, DevType, EscMode, FaultBit, Model, MFR, bitsToF32, idClass, idDevType, idIndex, idMfr, idNum, readF32 } from '@cygnus/protocol';
import type { BusFrame } from '../bus';
import { NodeMode, PEER_TIMEOUT_MS, SimNode, type InjectionKind, type SimNodeOptions } from '../node';
import { SUBSTEPS, clamp, type Motor, type MotorDriver } from '../world';

const SIGNAL_KEYS = [
  'bus.voltage',
  'bus.current',
  'phase.current',
  'duty',
  'velocity',
  'position',
  'setpoint',
  'error',
  'loop.output',
  'temp.fet',
  'temp.motor',
  'pwm.pulse',
  'energy',
  'ctrl.mode',
] as const;
const S_BUS_VOLTAGE = 0;
const S_BUS_CURRENT = 1;
const S_PHASE_CURRENT = 2;
const S_DUTY = 3;
const S_VELOCITY = 4;
const S_POSITION = 5;
const S_SETPOINT = 6;
const S_ERROR = 7;
const S_LOOP_OUTPUT = 8;
const S_TEMP_FET = 9;
const S_TEMP_MOTOR = 10;
const S_PWM_PULSE = 11;
const S_ENERGY = 12;
const S_CTRL_MODE = 13;

// Parameter slots, resolved to table indices once per board.
const PARAM_KEYS = [
  'motor.pole_pairs',
  'motor.invert',
  'motor.gear_ratio',
  'motor.idle_mode',
  'motor.ramp_s',
  'motor.pwm_khz',
  'motor.startup_duty',
  'limits.supply_current_a',
  'limits.phase_current_a',
  'limits.undervoltage_v',
  'limits.overvoltage_v',
  'limits.temp_c',
  'limits.motor_temp_c',
  'limits.duty_max',
  'limits.fwd_soft_enable',
  'limits.fwd_soft_rot',
  'limits.rev_soft_enable',
  'limits.rev_soft_rot',
  'current.kp',
  'current.ki',
  'vel.kp',
  'vel.ki',
  'vel.kd',
  'vel.ks',
  'vel.kv',
  'vel.ka',
  'vel.i_max',
  'vel.out_max',
  'vel.filter_hz',
  'pos.kp',
  'pos.ki',
  'pos.kd',
  'pos.i_max',
  'pos.cruise_rpm',
  'pos.accel_rpm_s',
  'pos.tolerance_rot',
  'fb.source',
  'fb.remote_num',
  'fb.sensor_invert',
  'fb.remote_ratio',
  'pwm.enable',
  'pwm.min_us',
  'pwm.mid_us',
  'pwm.max_us',
  'pwm.deadband_us',
  'pwm.bidirectional',
] as const;
const P_MOTOR_POLE_PAIRS = 0;
const P_MOTOR_INVERT = 1;
const P_MOTOR_GEAR_RATIO = 2;
const P_MOTOR_IDLE_MODE = 3;
const P_MOTOR_RAMP_S = 4;
const P_MOTOR_PWM_KHZ = 5;
const P_MOTOR_STARTUP_DUTY = 6;
const P_LIMITS_SUPPLY_CURRENT_A = 7;
const P_LIMITS_PHASE_CURRENT_A = 8;
const P_LIMITS_UNDERVOLTAGE_V = 9;
const P_LIMITS_OVERVOLTAGE_V = 10;
const P_LIMITS_TEMP_C = 11;
const P_LIMITS_MOTOR_TEMP_C = 12;
const P_LIMITS_DUTY_MAX = 13;
const P_LIMITS_FWD_SOFT_ENABLE = 14;
const P_LIMITS_FWD_SOFT_ROT = 15;
const P_LIMITS_REV_SOFT_ENABLE = 16;
const P_LIMITS_REV_SOFT_ROT = 17;
const P_CURRENT_KP = 18;
const P_CURRENT_KI = 19;
const P_VEL_KP = 20;
const P_VEL_KI = 21;
const P_VEL_KD = 22;
const P_VEL_KS = 23;
const P_VEL_KV = 24;
const P_VEL_KA = 25;
const P_VEL_I_MAX = 26;
const P_VEL_OUT_MAX = 27;
const P_VEL_FILTER_HZ = 28;
const P_POS_KP = 29;
const P_POS_KI = 30;
const P_POS_KD = 31;
const P_POS_I_MAX = 32;
const P_POS_CRUISE_RPM = 33;
const P_POS_ACCEL_RPM_S = 34;
const P_POS_TOLERANCE_ROT = 35;
const P_FB_SOURCE = 36;
const P_FB_REMOTE_NUM = 37;
const P_FB_SENSOR_INVERT = 38;
const P_FB_REMOTE_RATIO = 39;
const P_PWM_ENABLE = 40;
const P_PWM_MIN_US = 41;
const P_PWM_MID_US = 42;
const P_PWM_MAX_US = 43;
const P_PWM_DEADBAND_US = 44;
const P_PWM_BIDIRECTIONAL = 45;

const F = { MOTOR_DISCONNECTED: 10, SENSOR_LOST: 11, LOCKED_ROTOR: 12, REMOTE_SENSOR_LOST: 13 } as const;
const Drive = { COAST: 0, VOLTAGE: 1, CURRENT: 2, BRAKE: 3 } as const;
const Act = { NONE: 0, DETECT: 0x40, MEASURE: 0x41, CAL_PWM: 0x42 } as const;
const FbSource = { SENSORLESS: 0, HALL: 1, REMOTE: 2 } as const;

/** Board-level electrical constants per variant (power stage, not catalog settings). */
interface Stage {
  rdsOhm: number;
  thermalR: number;
  thermalC: number;
  hardMaxA: number;
}
const STAGES: Record<number, Stage> = {
  [Model.ESC_20A]: { rdsOhm: 0.006, thermalR: 4, thermalC: 15, hardMaxA: 48 },
  [Model.ESC_80A]: { rdsOhm: 0.0016, thermalR: 1.6, thermalC: 45, hardMaxA: 180 },
};

const SENSORLESS_MIN_RPM = 250;
const HALL_TIMEOUT_MS = 100;
const EDGE_RING = 16;

export interface EscOptions extends SimNodeOptions {
  /** The motor this ESC drives (null: nothing connected to the phases). */
  motor?: Motor | null;
}

/**
 * ESC 20A / 80A: BLDC drive with DC-equivalent motor physics, current limiting at 10 kHz,
 * voltage-output velocity/position loops (catalog gains are in volts), trapezoidal profiles,
 * hall/sensorless/remote-Cyncoder feedback, thermal model and protections.
 */
export class EscNode extends SimNode implements MotorDriver {
  motor: Motor | null;
  /** RC-style PWM input; a servo board channel or the panel writes `pulseUs`. */
  readonly pwmIn = { pulseUs: 0 };
  protected override readonly listensToPeers = true;
  private readonly stage: Stage;

  // command
  private ctrlMode: number = EscMode.OFF;
  private setpoint = 0;
  private driveKind: number = Drive.COAST;
  private vCmd = 0;
  private iTarget = 0;
  private dutyRamped = 0;
  private curInt = 0;
  // velocity loop
  private velInt = 0;
  private prevVelErr = 0;
  private prevVelSp = 0;
  // position loop
  private posInt = 0;
  private profP = 0;
  private profV = 0;
  private profA = 0;
  private loopOut = 0;
  private reference = 0;
  private loopErr = 0;
  // measurement
  private pos = 0;
  private vel = 0;
  private velF = 0;
  private posOffset = 0;
  private hallCount = 0;
  private hallInit = false;
  private readonly edgeT = new Float64Array(EDGE_RING);
  private readonly edgeDir = new Int8Array(EDGE_RING);
  private edgeHead = 0;
  private edgeN = 0;
  private sensorlessCount = 0;
  private remotePos = 0;
  private remoteVel = 0;
  private remoteAt = -1e9;
  private hallLost = false;
  // electrical/thermal
  private fetTemp = 25;
  private extraHeatW = 0;
  private supplyA = 0;
  private energyWh = 0;
  private lockedMs = 0;
  private disconnMs = 0;
  private uvLatched = false;
  private ovLatched = false;
  private locked = false;
  private disconnected = false;
  private derate = 1;
  // actions
  private act: number = Act.NONE;
  private actT0 = 0;
  private actA = 0;
  private actB = 0;
  private actC = 0;
  private actD = 0;

  // parameter indices
  private readonly P: Int32Array;
  // signal indices
  private readonly S: Int32Array;

  constructor(model: typeof Model.ESC_20A | typeof Model.ESC_80A, o: EscOptions = {}) {
    super(model, o);
    this.motor = o.motor ?? null;
    if (this.motor) this.motor.driver = this;
    this.stage = STAGES[model]!;
    this.streamGranularity = 5;
    this.P = Int32Array.from(PARAM_KEYS, (k) => this.params.index(k));
    this.S = Int32Array.from(SIGNAL_KEYS, (k) => this.sigIndex(k));
  }

  private pk(i: number): number {
    return this.p(this.P[i]!);
  }

  /** Attaches (or replaces) the motor on the phases. */
  setMotor(m: Motor | null): void {
    if (this.motor && this.motor.driver === this) this.motor.driver = null;
    this.motor = m;
    if (m) m.driver = this;
  }

  // ---- lifecycle -------------------------------------------------------------------------

  protected override onAttach(): void {
    this.fetTemp = this.ctx.world.ambientC;
  }

  protected override onAppStart(): void {
    this.resetLoops();
    this.ctrlMode = EscMode.OFF;
    this.setpoint = 0;
    this.posOffset = 0;
    this.hallInit = false;
    this.sensorlessCount = 0;
    this.edgeN = 0;
    this.locked = false;
    this.disconnected = false;
    this.act = Act.NONE;
    this.remoteAt = -1e9;
  }

  protected override onAppStop(): void {
    this.ctrlMode = EscMode.OFF;
    this.driveKind = Drive.COAST;
    this.act = Act.NONE;
  }

  private resetLoops(): void {
    this.curInt = 0;
    this.velInt = 0;
    this.prevVelErr = 0;
    this.prevVelSp = 0;
    this.posInt = 0;
    this.profP = this.pos;
    this.profV = this.vel / 60;
    this.profA = 0;
    this.dutyRamped = 0;
  }

  protected override neutral(): void {
    this.ctrlMode = EscMode.OFF;
    this.setpoint = 0;
    this.act = Act.NONE;
    this.resetLoops();
  }

  override isEnabled(): boolean {
    if (this.mode !== NodeMode.APP || this.estopped) return false;
    if (this.act !== Act.NONE && this.act !== Act.CAL_PWM) return true;
    if (this.commandable && this.ctrlMode !== EscMode.OFF) return true;
    return this.pwmDriving();
  }

  private pwmDriving(): boolean {
    return this.pk(P_PWM_ENABLE) !== 0 && this.pwmIn.pulseUs >= 800 && !this.commandable;
  }

  override supplyCurrent(): number {
    return this.mode === NodeMode.OFF ? 0 : this.supplyA;
  }

  // ---- CTRL ------------------------------------------------------------------------------

  protected override onCtrl(index: number, d: Uint8Array, len: number): boolean {
    if (index !== 0 || len < 8) return false;
    const mode = d[0] ?? 0;
    const value = readF32(d, 4);
    if (mode > EscMode.BRAKE || !Number.isFinite(value)) return false;
    if (mode !== this.ctrlMode) {
      this.ctrlMode = mode;
      this.resetLoops();
    }
    this.setpoint = value;
    return true;
  }

  // ---- remote Cyncoder -------------------------------------------------------------------

  protected override onPeerFrame(f: BusFrame): void {
    const id = f.id;
    if (idMfr(id) !== MFR || idClass(id) !== Cls.STATUS || idIndex(id) !== 0) return;
    if (idDevType(id) !== DevType.ENCODER || idNum(id) !== this.pk(P_FB_REMOTE_NUM) || f.len < 8) return;
    this.remotePos = readF32(f.data, 0);
    this.remoteVel = readF32(f.data, 4);
    this.remoteAt = this.now;
  }

  // ---- fast loop (10 kHz) ----------------------------------------------------------------

  drive(m: Motor, sub: number): void {
    if (this.mode !== NodeMode.APP) {
      m.coast = true;
      m.voltage = 0;
      return;
    }
    this.trackHall(m, sub);
    const vbus = this.supplyV;
    const sign = this.pk(P_MOTOR_INVERT) ? -1 : 1;
    const r = m.spec.resistance;
    const e = m.ke * m.omega;
    // Current available: phase limit, supply limit mapped through the duty, thermal derate.
    const phaseLim = this.pk(P_LIMITS_PHASE_CURRENT_A) * this.derate;
    const dutyMax = this.pk(P_LIMITS_DUTY_MAX);
    let v = 0;
    switch (this.driveKind) {
      case Drive.COAST:
        m.coast = true;
        m.voltage = 0;
        this.sampleFast(m, sub, vbus);
        return;
      case Drive.BRAKE:
        v = 0;
        break;
      case Drive.VOLTAGE: {
        let cmd = clamp(this.vCmd, -vbus * dutyMax, vbus * dutyMax);
        // Sensorless start: below measurable back-EMF the drive kicks with the startup duty.
        if (this.pk(P_FB_SOURCE) === FbSource.SENSORLESS && Math.abs(m.rpm) < SENSORLESS_MIN_RPM && Math.abs(cmd) > 0.01 * vbus) {
          const kick = this.pk(P_MOTOR_STARTUP_DUTY) * vbus;
          if (Math.abs(cmd) < kick) cmd = Math.sign(cmd) * kick;
        }
        v = sign * cmd;
        break;
      }
      case Drive.CURRENT: {
        const kp = this.pk(P_CURRENT_KP);
        const ki = this.pk(P_CURRENT_KI);
        const it = clamp(this.iTarget, -phaseLim, phaseLim);
        const err = it - sign * m.current;
        const vmax = vbus * dutyMax;
        let u = kp * err + this.curInt;
        // Conditional integration: no windup while the output is saturated.
        if (Math.abs(u) < vmax || Math.sign(err) !== Math.sign(u)) this.curInt += ki * err * (0.001 / SUBSTEPS);
        u = kp * err + this.curInt;
        v = sign * clamp(u, -vmax, vmax);
        break;
      }
    }
    const duty = vbus > 0.5 ? Math.abs(v) / vbus : 1;
    const supLim = this.pk(P_LIMITS_SUPPLY_CURRENT_A);
    const ilim = Math.min(phaseLim, supLim / Math.max(duty, 0.05), this.stage.hardMaxA);
    v = clamp(v, e - r * ilim, e + r * ilim);
    v = clamp(v, -vbus, vbus);
    m.coast = false;
    m.voltage = v;
    this.sampleFast(m, sub, vbus);
  }

  /** Mid-millisecond: refresh fast signals and take the 500 µs stream sample. */
  private sampleFast(m: Motor, sub: number, vbus: number): void {
    if (sub !== SUBSTEPS / 2) return;
    this.updateFastSignals(m, vbus);
    this.streamAdvance(5, 5);
  }

  private updateFastSignals(m: Motor | null, vbus: number): void {
    const sign = this.pk(P_MOTOR_INVERT) ? -1 : 1;
    const i = m ? m.current : 0;
    const v = m && !m.coast ? m.voltage : 0;
    this.supplyA = (vbus > 0.5 ? (i * v) / vbus : 0) + 0.06;
    const s = this.sig;
    s[this.S[S_PHASE_CURRENT]!] = sign * i + this.rng.gauss() * 0.04;
    s[this.S[S_BUS_CURRENT]!] = this.supplyA + this.rng.gauss() * 0.02;
    s[this.S[S_DUTY]!] = vbus > 0.5 ? (sign * v) / vbus : 0;
  }

  /** Hall edge timing at substep resolution, interpolated to the crossing instant. */
  private trackHall(m: Motor, sub: number): void {
    const edges = 6 * m.spec.polePairs;
    const a = m.angleRot * edges;
    const c = Math.floor(a);
    if (!this.hallInit) {
      this.hallCount = c;
      this.hallInit = true;
      return;
    }
    if (c === this.hallCount) return;
    const dir = c > this.hallCount ? 1 : -1;
    const n = Math.min(Math.abs(c - this.hallCount), EDGE_RING);
    const t = this.now + (sub + 1) / SUBSTEPS;
    const per = this.edgeN > 0 ? Math.max(0.01, t - this.edgeT[(this.edgeHead + EDGE_RING - 1) % EDGE_RING]!) : 1;
    for (let k = 0; k < n; k++) {
      // Timer resolution plus hall placement error (a few electrical degrees).
      const jitter = (this.rng.gauss() * (0.003 + 0.02 * per)) / n;
      this.edgeT[this.edgeHead] = t - ((n - 1 - k) * (1 / SUBSTEPS)) / n + jitter;
      this.edgeDir[this.edgeHead] = dir;
      this.edgeHead = (this.edgeHead + 1) % EDGE_RING;
      if (this.edgeN < EDGE_RING) this.edgeN++;
    }
    // Sensorless commutation only tracks the rotor once back-EMF is measurable.
    if (Math.abs(m.rpm) >= SENSORLESS_MIN_RPM) this.sensorlessCount += c - this.hallCount;
    this.hallCount = c;
  }

  // ---- 1 kHz -----------------------------------------------------------------------------

  protected override appTick(): void {
    const m = this.motor;
    const vbus = this.supplyV;
    this.measure(m);
    this.protect(m, vbus);
    this.control(vbus);
    this.thermal(m);
    if (!m) {
      this.updateFastSignals(null, vbus);
      this.streamAdvance(5, 5);
    }
    this.energyWh += (vbus * this.supplyA) / 3.6e6;
    const s = this.sig;
    const S = this.S;
    s[S[S_BUS_VOLTAGE]!] = vbus + this.rng.gauss() * 0.015;
    s[S[S_VELOCITY]!] = this.velF;
    s[S[S_POSITION]!] = this.pos;
    s[S[S_SETPOINT]!] = this.reference;
    s[S[S_ERROR]!] = this.loopErr;
    s[S[S_LOOP_OUTPUT]!] = this.loopOut;
    s[S[S_TEMP_FET]!] = this.fetTemp + this.rng.gauss() * 0.1;
    s[S[S_TEMP_MOTOR]!] = m ? m.tempC : this.ctx.world.ambientC;
    s[S[S_PWM_PULSE]!] = this.pwmIn.pulseUs;
    s[S[S_ENERGY]!] = this.energyWh;
    s[S[S_CTRL_MODE]!] = this.pwmDriving() ? EscMode.DUTY : this.ctrlMode;
    this.actionTick(m, vbus);
  }

  private measure(m: Motor | null): void {
    const src = this.pk(P_FB_SOURCE);
    const pp = Math.max(1, this.pk(P_MOTOR_POLE_PAIRS));
    const gear = this.pk(P_MOTOR_GEAR_RATIO) || 1;
    const inv = this.pk(P_MOTOR_INVERT) ? -1 : 1;
    const sInv = this.pk(P_FB_SENSOR_INVERT) ? -1 : 1;
    let motorRot = 0;
    let motorRpm = 0;
    if (src === FbSource.REMOTE) {
      const ratio = this.pk(P_FB_REMOTE_RATIO) || 1;
      // Remote position is mechanism-side already: only the ratio and sensor direction apply.
      this.pos = (sInv * this.remotePos) / ratio - this.posOffset;
      this.vel = (sInv * this.remoteVel) / ratio;
    } else if (m) {
      const hallSign = m.hallInverted && src === FbSource.HALL ? -1 : 1;
      const counts = src === FbSource.HALL ? this.hallCount * hallSign : this.sensorlessCount;
      motorRot = counts / (6 * pp);
      motorRpm = this.edgeVelocityRpm(pp) * (src === FbSource.HALL ? hallSign : 1);
      if (src === FbSource.SENSORLESS && Math.abs(m.rpm) < SENSORLESS_MIN_RPM) motorRpm = 0;
      if (src === FbSource.HALL && this.hallLost) {
        motorRpm = 0;
        motorRot = 0;
      }
      this.pos = (inv * sInv * motorRot) / gear - this.posOffset;
      this.vel = (inv * sInv * motorRpm) / gear;
    } else {
      this.vel = 0;
    }
    const fc = this.pk(P_VEL_FILTER_HZ);
    const alpha = 1 - Math.exp(-2 * Math.PI * fc * 0.001);
    this.velF += (this.vel - this.velF) * alpha;
  }

  /** Velocity from the last electrical revolution of hall edges (6 edges average out placement error). */
  private edgeVelocityRpm(pp: number): number {
    if (this.edgeN < 2) return 0;
    const last = (this.edgeHead + EDGE_RING - 1) % EDGE_RING;
    const tLast = this.edgeT[last]!;
    if (this.now - tLast > HALL_TIMEOUT_MS) return 0;
    const span = Math.min(this.edgeN - 1, 6);
    const first = (last + EDGE_RING - span) % EDGE_RING;
    const dt = tLast - this.edgeT[first]!;
    if (dt <= 0) return 0;
    let dir = 0;
    for (let k = 0; k <= span; k++) dir += this.edgeDir[(first + k) % EDGE_RING]!;
    const edges = (dir >= 0 ? 1 : -1) * span;
    // A slow shaft that stopped: the open interval since the last edge bounds the speed.
    const open = this.now - tLast;
    const effDt = Math.max(dt, open * span);
    return ((edges / (6 * pp)) / (effDt / 1000)) * 60;
  }

  private protect(m: Motor | null, vbus: number): void {
    const uv = this.pk(P_LIMITS_UNDERVOLTAGE_V);
    const ov = this.pk(P_LIMITS_OVERVOLTAGE_V);
    if (vbus < uv) this.uvLatched = true;
    else if (vbus > uv + 0.3) this.uvLatched = false;
    if (vbus > ov) this.ovLatched = true;
    else if (vbus < ov - 0.3) this.ovLatched = false;
    this.setFault(FaultBit.UNDERVOLT, this.uvLatched);
    this.setFault(FaultBit.OVERVOLT, this.ovLatched);
    const tLim = this.pk(P_LIMITS_TEMP_C);
    this.derate = clamp((tLim - this.fetTemp) / 15, 0, 1);
    const mtLim = this.pk(P_LIMITS_MOTOR_TEMP_C);
    const motorHot = mtLim > 0 && m !== null && m.tempC > mtLim;
    this.setFault(FaultBit.OVERTEMP, this.fetTemp >= tLim || motorHot);
    if (m) {
      const iAbs = Math.abs(m.current);
      if (iAbs > this.stage.hardMaxA) this.setFault(FaultBit.OVERCURRENT, true);
      else if (this.hasFault(FaultBit.OVERCURRENT) && iAbs < this.stage.hardMaxA * 0.8) this.setFault(FaultBit.OVERCURRENT, false);
      const driving = this.driveKind === Drive.VOLTAGE || this.driveKind === Drive.CURRENT;
      if (driving && iAbs > 0.6 * this.pk(P_LIMITS_PHASE_CURRENT_A) && Math.abs(m.rpm) < 20) this.lockedMs++;
      else this.lockedMs = 0;
      if (this.lockedMs > 1500) this.locked = true;
      const pushing = driving && (Math.abs(this.vCmd) > 1 || Math.abs(this.iTarget) > 1);
      if (pushing && iAbs < 0.05 && Math.abs(m.rpm) < 5) this.disconnMs++;
      else this.disconnMs = 0;
      if (this.disconnMs > 100) this.disconnected = true;
    } else if (this.driveKind !== Drive.COAST && this.driveKind !== Drive.BRAKE) {
      this.disconnected = true;
    }
    this.setFault(F.LOCKED_ROTOR, this.locked);
    this.setFault(F.MOTOR_DISCONNECTED, this.disconnected);
    const src = this.pk(P_FB_SOURCE);
    this.setFault(F.SENSOR_LOST, src === FbSource.HALL && this.hallLost);
    const remoteLost = src === FbSource.REMOTE && this.now - this.remoteAt > PEER_TIMEOUT_MS;
    this.setFault(F.REMOTE_SENSOR_LOST, remoteLost);
  }

  protected override onClearFaults(): void {
    this.locked = false;
    this.disconnected = false;
    this.lockedMs = 0;
    this.disconnMs = 0;
  }

  /** Faults that remove drive entirely. */
  private cutting(): boolean {
    return (
      this.uvLatched ||
      this.ovLatched ||
      this.locked ||
      this.disconnected ||
      this.hasFault(FaultBit.OVERTEMP) ||
      this.hasFault(F.SENSOR_LOST) ||
      this.hasFault(FaultBit.HARDWARE)
    );
  }

  private idle(): void {
    this.driveKind = this.pk(P_MOTOR_IDLE_MODE) === 0 ? Drive.BRAKE : Drive.COAST;
    this.vCmd = 0;
    this.iTarget = 0;
    this.loopOut = 0;
    this.reference = 0;
    this.loopErr = 0;
  }

  private control(vbus: number): void {
    if (this.act !== Act.NONE && this.act !== Act.CAL_PWM) return; // the action drives the motor
    if (this.cutting() || this.estopped) {
      this.driveKind = Drive.COAST;
      this.loopOut = 0;
      return;
    }
    let mode = this.ctrlMode;
    let sp = this.setpoint;
    if (!this.commandable) {
      if (this.pwmDriving()) {
        mode = EscMode.DUTY;
        sp = this.pwmToDuty(this.pwmIn.pulseUs);
      } else {
        this.idle();
        this.dutyRamped = 0;
        return;
      }
    }
    const remoteLost = this.hasFault(F.REMOTE_SENSOR_LOST);
    const dt = 0.001;
    switch (mode) {
      case EscMode.OFF:
        this.idle();
        return;
      case EscMode.BRAKE:
        this.driveKind = Drive.BRAKE;
        this.vCmd = 0;
        this.loopOut = 0;
        this.reference = 0;
        this.loopErr = 0;
        return;
      case EscMode.DUTY: {
        const dmax = this.pk(P_LIMITS_DUTY_MAX);
        const target = clamp(sp, -dmax, dmax);
        const ramp = this.pk(P_MOTOR_RAMP_S);
        if (ramp > 0) {
          const step = dt / ramp;
          this.dutyRamped += clamp(target - this.dutyRamped, -step, step);
        } else this.dutyRamped = target;
        this.reference = target;
        this.loopErr = target - this.dutyRamped;
        this.setVoltage(this.dutyRamped * vbus);
        return;
      }
      case EscMode.CURRENT: {
        this.driveKind = Drive.CURRENT;
        let it = sp;
        it = this.softLimit(it);
        this.iTarget = it;
        this.reference = sp;
        this.loopErr = sp - (this.sig[this.S[S_PHASE_CURRENT]!] ?? 0);
        this.loopOut = this.motor ? this.motor.voltage * (this.pk(P_MOTOR_INVERT) ? -1 : 1) : 0;
        return;
      }
      case EscMode.VELOCITY: {
        if (remoteLost) return this.idle();
        const kp = this.pk(P_VEL_KP);
        const ki = this.pk(P_VEL_KI);
        const kd = this.pk(P_VEL_KD);
        const iMax = this.pk(P_VEL_I_MAX);
        const err = sp - this.velF;
        this.velInt = clamp(this.velInt + ki * err * dt, -iMax, iMax);
        const d = (kd * (err - this.prevVelErr)) / dt;
        this.prevVelErr = err;
        const acc = (sp - this.prevVelSp) / dt;
        this.prevVelSp = sp;
        const ff = this.feedforward(sp, acc);
        const outMax = this.pk(P_VEL_OUT_MAX);
        const out = clamp(kp * err + this.velInt + d + ff, -outMax, outMax);
        this.reference = sp;
        this.loopErr = err;
        this.setVoltage(out);
        return;
      }
      case EscMode.POSITION: {
        if (remoteLost) return this.idle();
        this.profileStep(sp, dt);
        const kp = this.pk(P_POS_KP);
        const ki = this.pk(P_POS_KI);
        const kd = this.pk(P_POS_KD);
        const iMax = this.pk(P_POS_I_MAX);
        const err = this.profP - this.pos;
        const tol = this.pk(P_POS_TOLERANCE_ROT);
        const done = this.profP === sp && this.profV === 0;
        this.reference = this.profP;
        this.loopErr = err;
        // Inside the allowed error the loop treats the error as zero: P and I stop acting and the
        // learned integral (e.g. the gravity load) keeps holding.
        const within = done && Math.abs(sp - this.pos) < tol;
        const e = within ? 0 : err;
        this.posInt = clamp(this.posInt + ki * e * dt, -iMax, iMax);
        const dErr = this.profV - this.velF / 60; // rot/s
        const out = kp * e + this.posInt + kd * dErr + this.feedforward(this.profV * 60, this.profA * 60);
        this.setVoltage(clamp(out, -vbus, vbus));
        return;
      }
    }
  }

  private feedforward(rpm: number, rpmPerS: number): number {
    const ks = this.pk(P_VEL_KS);
    return (rpm > 0 ? ks : rpm < 0 ? -ks : 0) + this.pk(P_VEL_KV) * rpm + this.pk(P_VEL_KA) * rpmPerS;
  }

  /** Trapezoidal motion profile towards `goal` (rot); state in rot, rot/s, rot/s². */
  private profileStep(goal: number, dt: number): void {
    const cruise = this.pk(P_POS_CRUISE_RPM) / 60;
    if (cruise <= 0) {
      this.profP = goal;
      this.profV = 0;
      this.profA = 0;
      return;
    }
    const accRaw = this.pk(P_POS_ACCEL_RPM_S) / 60;
    const acc = accRaw > 0 ? accRaw : 1e9;
    const dist = goal - this.profP;
    const v = this.profV;
    if (Math.abs(dist) < 1e-9 && Math.abs(v) < acc * dt) {
      this.profP = goal;
      this.profV = 0;
      this.profA = 0;
      return;
    }
    const dir = Math.sign(dist) || Math.sign(-v);
    // Stop distance at the current speed decides whether to keep accelerating or brake.
    const stopDist = (v * v) / (2 * acc);
    let target: number;
    if (Math.sign(v) === dir && stopDist >= Math.abs(dist)) target = 0;
    else target = dir * cruise;
    const nv = v + clamp(target - v, -acc * dt, acc * dt);
    this.profA = (nv - v) / dt;
    this.profV = nv;
    let np = this.profP + nv * dt;
    if ((goal - np) * dir < 0) {
      np = goal;
      this.profV = 0;
      this.profA = 0;
    }
    this.profP = np;
  }

  private softLimit(out: number): number {
    if (this.pk(P_LIMITS_FWD_SOFT_ENABLE) && this.pos >= this.pk(P_LIMITS_FWD_SOFT_ROT) && out > 0) return 0;
    if (this.pk(P_LIMITS_REV_SOFT_ENABLE) && this.pos <= this.pk(P_LIMITS_REV_SOFT_ROT) && out < 0) return 0;
    return out;
  }

  private setVoltage(v: number): void {
    const out = this.softLimit(v);
    this.driveKind = Drive.VOLTAGE;
    this.vCmd = out;
    this.loopOut = out;
  }

  private pwmToDuty(p: number): number {
    const min = this.pk(P_PWM_MIN_US);
    const mid = this.pk(P_PWM_MID_US);
    const max = this.pk(P_PWM_MAX_US);
    const db = this.pk(P_PWM_DEADBAND_US);
    if (this.pk(P_PWM_BIDIRECTIONAL)) {
      if (Math.abs(p - mid) <= db / 2) return 0;
      return p > mid ? clamp((p - mid) / Math.max(1, max - mid), 0, 1) : -clamp((mid - p) / Math.max(1, mid - min), 0, 1);
    }
    if (p <= min + db / 2) return 0;
    return clamp((p - min) / Math.max(1, max - min), 0, 1);
  }

  private thermal(m: Motor | null): void {
    const i = m ? m.current : 0;
    const vbus = this.supplyV;
    const p = i * i * this.stage.rdsOhm * 2 + 4e-5 * this.pk(P_MOTOR_PWM_KHZ) * vbus * Math.abs(i) + 0.15 + this.extraHeatW;
    const amb = this.ctx.world.ambientC;
    this.fetTemp += ((p - (this.fetTemp - amb) / this.stage.thermalR) / this.stage.thermalC) * 0.001;
  }

  // ---- actions ---------------------------------------------------------------------------

  protected override action(cmd: number, arg: number): { status: number; result: number } {
    const busy = this.isEnabled();
    switch (cmd) {
      case Act.DETECT:
      case Act.MEASURE: {
        if (busy || this.estopped || this.cutting()) return { status: CommandStatus.DENIED, result: 0 };
        if (!this.motor) return { status: CommandStatus.FAILED, result: 0 };
        if (cmd === Act.DETECT && this.pk(P_FB_SOURCE) === FbSource.SENSORLESS) return { status: CommandStatus.OK, result: 0 };
        this.act = cmd;
        this.actT0 = this.now;
        this.actA = this.sensorRaw();
        this.actB = 0;
        this.actC = 0;
        this.actD = 0;
        return { status: CommandStatus.IN_PROGRESS, result: 0 };
      }
      case Act.CAL_PWM:
        if (busy) return { status: CommandStatus.DENIED, result: 0 };
        this.act = cmd;
        this.actT0 = this.now;
        this.actA = 1e9; // min
        this.actB = 0; // max
        this.actC = 0; // center sum
        this.actD = 0; // center samples
        return { status: CommandStatus.IN_PROGRESS, result: 0 };
      case 0x43: {
        const target = bitsToF32(arg);
        if (!Number.isFinite(target)) return { status: CommandStatus.INVALID_ARG, result: 0 };
        this.posOffset += this.pos - target;
        this.pos = target;
        this.profP = target;
        return { status: CommandStatus.OK, result: 0 };
      }
    }
    return { status: CommandStatus.UNSUPPORTED, result: 0 };
  }

  /** Sensor reading in sensor counts as the firmware sees it before inversion settings. */
  private sensorRaw(): number {
    const src = this.pk(P_FB_SOURCE);
    if (src === FbSource.REMOTE) return this.remotePos;
    const m = this.motor;
    return m && m.hallInverted ? -this.hallCount : this.hallCount;
  }

  private actionTick(m: Motor | null, vbus: number): void {
    if (this.act === Act.NONE) return;
    const t = this.now - this.actT0;
    if (this.act === Act.CAL_PWM) {
      const p = this.pwmIn.pulseUs;
      if (p >= 800) {
        if (t < 1500) {
          this.actC += p;
          this.actD++;
        }
        this.actA = Math.min(this.actA, p);
        this.actB = Math.max(this.actB, p);
      }
      if (t >= 6000) {
        this.act = Act.NONE;
        if (this.actB - this.actA < 300 || this.actD === 0) return this.completeCommand(Act.CAL_PWM, CommandStatus.FAILED, 0);
        this.params.setKey('pwm.min_us', Math.round(this.actA));
        this.params.setKey('pwm.max_us', Math.round(this.actB));
        this.params.setKey('pwm.mid_us', Math.round(this.actC / this.actD));
        this.completeCommand(Act.CAL_PWM, CommandStatus.OK, 0);
      }
      return;
    }
    if (!m || this.cutting() || this.estopped) {
      const cmd = this.act;
      this.act = Act.NONE;
      this.driveKind = Drive.COAST;
      return this.completeCommand(cmd, CommandStatus.FAILED, 0);
    }
    if (this.act === Act.DETECT) {
      this.driveKind = Drive.VOLTAGE;
      this.vCmd = 0.15 * vbus;
      if (t >= 600) {
        this.act = Act.NONE;
        this.driveKind = Drive.COAST;
        const delta = this.sensorRaw() - this.actA;
        if (Math.abs(delta) < 1e-3) return this.completeCommand(Act.DETECT, CommandStatus.FAILED, 0);
        const inv = this.pk(P_MOTOR_INVERT) ? -1 : 1;
        // Driving "positive" must move the sensor positive once inversion settings apply.
        const newInvert = delta * inv < 0 ? 1 : 0;
        this.params.setKey('fb.sensor_invert', newInvert);
        this.completeCommand(Act.DETECT, CommandStatus.OK, newInvert);
      }
      return;
    }
    // MEASURE: 300 ms locked-rotor DC for R and L, then 1 s spin at half duty for kV.
    if (t < 300) {
      this.driveKind = Drive.VOLTAGE;
      this.vCmd = 0;
      return;
    }
    this.driveKind = Drive.VOLTAGE;
    this.vCmd = 0.5 * vbus * (this.pk(P_MOTOR_INVERT) ? -1 : 1);
    if (t > 900) {
      // Average the back-EMF ratio over the steady part of the spin.
      const v = m.voltage - m.current * m.spec.resistance;
      if (Math.abs(v) > 0.5) {
        this.actB += Math.abs(m.rpm / v);
        this.actC++;
      }
    }
    if (t >= 1300) {
      this.act = Act.NONE;
      this.driveKind = Drive.COAST;
      if (this.actC === 0) return this.completeCommand(Act.MEASURE, CommandStatus.FAILED, 0);
      const err = (): number => 1 + this.rng.gauss() * 0.02;
      this.params.setKey('motor.resistance_ohm', m.spec.resistance * err());
      this.params.setKey('motor.inductance_uh', m.spec.inductance * 1e6 * err());
      this.params.setKey('motor.kv_rpm_per_v', (this.actB / this.actC) * (1 + this.rng.gauss() * 0.005));
      this.completeCommand(Act.MEASURE, CommandStatus.OK, 0);
    }
  }

  protected override selfTest(): number {
    let bits = 0;
    if (this.pk(P_FB_SOURCE) === FbSource.HALL && this.hallLost) bits |= 1 << 4;
    if (this.disconnected || (this.motor && !this.motor.connected)) bits |= 1 << 0;
    return bits;
  }

  // ---- injection -------------------------------------------------------------------------

  override supportedInjections(): InjectionKind[] {
    return ['overtemp', 'motorDisconnected', 'hallLost', 'jam'];
  }

  protected override injectModel(kind: InjectionKind, on: boolean): boolean {
    switch (kind) {
      case 'overtemp':
        this.extraHeatW = on ? (this.stage.thermalC * 6) : 0;
        return true;
      case 'motorDisconnected':
        if (this.motor) this.motor.connected = !on;
        return true;
      case 'hallLost':
        this.hallLost = on;
        return true;
      case 'jam':
        if (this.motor) this.motor.shaft.jammed = on;
        return true;
    }
    return false;
  }

  protected override activeModelInjections(): InjectionKind[] {
    const out: InjectionKind[] = [];
    if (this.extraHeatW > 0) out.push('overtemp');
    if (this.motor && !this.motor.connected) out.push('motorDisconnected');
    if (this.hallLost) out.push('hallLost');
    if (this.motor?.shaft.jammed) out.push('jam');
    return out;
  }

  /** FET temperature, °C (panel). */
  get fetTemperature(): number {
    return this.fetTemp;
  }
}
