import type { Prng } from './prng';

const TWO_PI = 2 * Math.PI;
const RPM_PER_RADS = 60 / TWO_PI;
const GRAVITY = 9.81;

/** Physics substeps per 1 ms simulation step; the ESC current loop runs at this rate (10 kHz). */
export const SUBSTEPS = 10;
export const SUBSTEP_S = 0.001 / SUBSTEPS;

// ---------------------------------------------------------------------------------------
// Motors

export interface MotorSpec {
  key: string;
  /** No-load speed per volt, rpm/V. */
  kv: number;
  /** Phase resistance (DC equivalent), Ω. */
  resistance: number;
  /** Inductance, H. */
  inductance: number;
  /** Rotor inertia, kg·m². */
  rotorInertia: number;
  polePairs: number;
  /** Bearing/brush friction, N·m (Coulomb) and N·m·s/rad (viscous, includes iron loss). */
  coulomb: number;
  viscous: number;
  /** Winding-to-ambient thermal resistance K/W and capacity J/K. */
  thermalR: number;
  thermalC: number;
}

/** Representative motors (values in the range of their commercial counterparts). */
export const MOTORS = {
  /** FRC-class 80 A brushless (NEO-like). */
  neo: { key: 'neo', kv: 473, resistance: 0.114, inductance: 60e-6, rotorInertia: 1.2e-5, polePairs: 7, coulomb: 0.012, viscous: 4e-5, thermalR: 1.4, thermalC: 300 },
  /** Small 20 A brushless (NEO 550-like). */
  neo550: { key: 'neo550', kv: 917, resistance: 0.11, inductance: 60e-6, rotorInertia: 1.5e-6, polePairs: 7, coulomb: 0.004, viscous: 8e-6, thermalR: 3, thermalC: 90 },
  /** 2212-class drone motor. */
  drone: { key: 'drone', kv: 920, resistance: 0.12, inductance: 40e-6, rotorInertia: 3e-6, polePairs: 7, coulomb: 0.002, viscous: 2e-6, thermalR: 4, thermalC: 40 },
  /** Underwater thruster motor (T200-like). */
  thruster: { key: 'thruster', kv: 1100, resistance: 0.09, inductance: 30e-6, rotorInertia: 4e-6, polePairs: 7, coulomb: 0.006, viscous: 1e-5, thermalR: 2, thermalC: 120 },
  /** Geared DC motor inside the sealed servo (seen at the motor). */
  servoCore: { key: 'servoCore', kv: 1400, resistance: 1.2, inductance: 200e-6, rotorInertia: 2e-7, polePairs: 2, coulomb: 0.0015, viscous: 1e-6, thermalR: 12, thermalC: 25 },
} as const satisfies Record<string, MotorSpec>;

/** Firmware that drives a motor; called every physics substep (10 kHz). */
export interface MotorDriver {
  /** Sets `m.voltage` / `m.coast` for the next substep. `sub` counts 0..SUBSTEPS-1 within the ms. */
  drive(m: Motor, sub: number): void;
}

export class Motor {
  readonly spec: MotorSpec;
  /** Back-EMF constant = torque constant, V·s/rad. */
  readonly ke: number;
  /** Motor turns per shaft turn. */
  readonly gear: number;
  readonly shaft: Shaft;
  driver: MotorDriver | null = null;
  /** Applied phase voltage (DC equivalent). */
  voltage = 0;
  /** Phases open (coast): no current can be driven. */
  coast = true;
  current = 0;
  tempC = 25;
  connected = true;
  /** Hall wiring reversed (the ESC's "detect direction" finds this). */
  hallInverted = false;
  /** Rotor angle offset so motor and shaft zero need not coincide. */
  readonly angleOffset: number;
  private readonly decay: number;

  constructor(spec: MotorSpec, shaft: Shaft, gear: number, rng: Prng) {
    this.spec = spec;
    this.shaft = shaft;
    this.gear = gear;
    this.ke = 60 / (TWO_PI * spec.kv);
    this.decay = Math.exp((-SUBSTEP_S * spec.resistance) / spec.inductance);
    this.angleOffset = rng.next();
  }

  /** Motor speed, rad/s. */
  get omega(): number {
    return this.shaft.omega * this.gear;
  }

  get rpm(): number {
    return this.omega * RPM_PER_RADS;
  }

  /** Motor rotor position, turns (continuous). */
  get angleRot(): number {
    return (this.shaft.angle * this.gear) / TWO_PI + this.angleOffset;
  }

  get torque(): number {
    return this.ke * this.current;
  }

  /** Exact RL step with back-EMF held for the substep. */
  electrical(): void {
    if (!this.connected) {
      this.current = 0;
      return;
    }
    const r = this.spec.resistance;
    if (this.coast) {
      this.current *= this.decay * this.decay * this.decay;
      if (Math.abs(this.current) < 1e-4) this.current = 0;
      return;
    }
    const iss = (this.voltage - this.ke * this.omega) / r;
    this.current = iss + (this.current - iss) * this.decay;
  }

  thermal(dtS: number, ambient: number): void {
    const p = this.current * this.current * this.spec.resistance;
    this.tempC += ((p - (this.tempC - ambient) / this.spec.thermalR) / this.spec.thermalC) * dtS;
  }
}

// ---------------------------------------------------------------------------------------
// Shafts

export interface ShaftOptions {
  id: string;
  label?: string;
  /** Inertia of the mechanism on this shaft, kg·m² (motor rotors are added automatically). */
  inertia: number;
  viscous?: number;
  coulomb?: number;
  /** Breakaway torque; defaults to 1.2 × coulomb. */
  stiction?: number;
  /** Arm under gravity: peak torque (horizontal) and the angle (rot) at which it hangs down. */
  gravity?: { torqueNm: number; downRot: number };
  /** Hard stops, rot. */
  stops?: { minRot: number; maxRot: number; restitution?: number };
  /** Propeller/impeller: thrust = kT·ω|ω| (N), drag torque = kQ·ω|ω| (N·m), ω in rad/s. */
  prop?: { kT: number; kQ: number };
  initialRot?: number;
}

export class Shaft {
  readonly id: string;
  label: string;
  inertia: number;
  viscous: number;
  coulomb: number;
  stiction: number;
  gravity: { torqueNm: number; downRot: number } | null;
  stops: { minRot: number; maxRot: number; restitution: number } | null;
  prop: { kT: number; kQ: number } | null;
  /** rad, rad/s */
  angle: number;
  omega = 0;
  /** User load torque (opposes nothing in particular: a constant torque), N·m. */
  load = 0;
  /** Step disturbance torque and when it ends (sim ms, −1 = until cleared). */
  disturbance = 0;
  disturbanceUntil = -1;
  /** Hand override: shaft follows `handOmega` kinematically while active. */
  handActive = false;
  handOmega = 0;
  handUntil = -1;
  /** Shaft locked solid (jammed mechanism). */
  jammed = false;
  readonly motors: Motor[] = [];
  /** Net torque of the last substep (for display), N·m. */
  netTorque = 0;
  private jTotal = 0;
  private bTotal = 0;
  private tcTotal = 0;
  private tsTotal = 0;

  constructor(o: ShaftOptions) {
    this.id = o.id;
    this.label = o.label ?? o.id;
    this.inertia = o.inertia;
    this.viscous = o.viscous ?? 0;
    this.coulomb = o.coulomb ?? 0;
    this.stiction = o.stiction ?? this.coulomb * 1.2;
    this.gravity = o.gravity ?? null;
    this.stops = o.stops ? { minRot: o.stops.minRot, maxRot: o.stops.maxRot, restitution: o.stops.restitution ?? 0.2 } : null;
    this.prop = o.prop ?? null;
    this.angle = (o.initialRot ?? 0) * TWO_PI;
    this.recompute();
  }

  /** Folds attached motors (reflected inertia and friction) into the shaft totals. */
  recompute(): void {
    let j = this.inertia;
    let b = this.viscous;
    let tc = this.coulomb;
    let ts = this.stiction;
    for (const m of this.motors) {
      const g2 = m.gear * m.gear;
      j += g2 * m.spec.rotorInertia;
      b += g2 * m.spec.viscous;
      tc += Math.abs(m.gear) * m.spec.coulomb;
      ts += Math.abs(m.gear) * m.spec.coulomb * 1.2;
    }
    this.jTotal = j;
    this.bTotal = b;
    this.tcTotal = tc;
    this.tsTotal = ts;
  }

  get rot(): number {
    return this.angle / TWO_PI;
  }

  get rpm(): number {
    return this.omega * RPM_PER_RADS;
  }

  /** Signed thrust of a propeller shaft, N. */
  get thrust(): number {
    return this.prop ? this.prop.kT * this.omega * Math.abs(this.omega) : 0;
  }

  /** Reaction (drag) torque of a propeller shaft, N·m. */
  get propTorque(): number {
    return this.prop ? this.prop.kQ * this.omega * Math.abs(this.omega) : 0;
  }

  substep(dt: number): void {
    if (this.jammed) {
      this.omega = 0;
      return;
    }
    if (this.handActive) {
      this.omega = this.handOmega;
      this.angle += this.omega * dt;
      this.applyStops();
      return;
    }
    let tau = this.load + this.disturbance;
    for (let k = 0; k < this.motors.length; k++) {
      const m = this.motors[k]!;
      tau += m.torque * m.gear;
    }
    if (this.gravity) tau -= this.gravity.torqueNm * Math.sin(this.angle - this.gravity.downRot * TWO_PI);
    const w = this.omega;
    // Stiction: a shaft at rest stays at rest until the drive torque breaks it free.
    if (w === 0 && Math.abs(tau) <= this.tsTotal) {
      this.netTorque = 0;
      return;
    }
    const sgn = w !== 0 ? Math.sign(w) : Math.sign(tau);
    const drive = tau - this.tcTotal * sgn;
    // Viscous and propeller drag are integrated implicitly: propeller drag is stiff at speed.
    const kq = this.prop ? this.prop.kQ : 0;
    const aw = Math.abs(w);
    let nw = (this.jTotal * w + dt * (drive + kq * w * aw)) / (this.jTotal + dt * (this.bTotal + 2 * kq * aw));
    if (w !== 0 && Math.sign(nw) !== Math.sign(w) && Math.abs(tau) <= this.tsTotal) nw = 0;
    this.netTorque = drive - this.bTotal * nw - kq * nw * Math.abs(nw);
    this.omega = nw;
    this.angle += nw * dt;
    this.applyStops();
  }

  private applyStops(): void {
    const s = this.stops;
    if (!s) return;
    const lo = s.minRot * TWO_PI;
    const hi = s.maxRot * TWO_PI;
    if (this.angle > hi) {
      this.angle = hi;
      if (this.omega > 0) this.omega = this.handActive ? 0 : -this.omega * s.restitution;
    } else if (this.angle < lo) {
      this.angle = lo;
      if (this.omega < 0) this.omega = this.handActive ? 0 : -this.omega * s.restitution;
    }
  }
}

// ---------------------------------------------------------------------------------------
// Power

/** A supply point: battery terminals, a PDH channel, a regulator output. */
export class PowerFeed {
  voltage = 0;
  /** Current drawn this step (accumulated by the simulation). */
  load = 0;
  /** The board that supplies this feed (PDH, regulator); null for the battery. */
  constructor(
    readonly label: string,
    readonly owner: object | null = null,
  ) {}
}

export class Battery {
  /** Open-circuit voltage when full. */
  nominalV: number;
  internalR: number;
  capacityAh: number;
  usedAh = 0;
  current = 0;
  readonly feed = new PowerFeed('battery');
  connected = true;

  constructor(o: { nominalV?: number; internalR?: number; capacityAh?: number } = {}) {
    this.nominalV = o.nominalV ?? 12.8;
    this.internalR = o.internalR ?? 0.015;
    this.capacityAh = o.capacityAh ?? 18;
    this.feed.voltage = this.nominalV;
  }

  /** Open-circuit voltage, dropping ~8 % over the capacity. */
  get ocv(): number {
    const soc = Math.max(0, 1 - this.usedAh / this.capacityAh);
    return this.nominalV * (0.92 + 0.08 * soc);
  }

  update(totalA: number, dtS: number): void {
    this.current = totalA;
    if (!this.connected) {
      this.feed.voltage = 0;
      return;
    }
    this.usedAh = Math.max(0, this.usedAh + (totalA * dtS) / 3600);
    const target = Math.max(0, this.ocv - this.internalR * totalA);
    // A small low-pass stands in for bus capacitance and breaks the one-step current/voltage loop.
    this.feed.voltage += (target - this.feed.voltage) * 0.5;
  }
}

/**
 * Hobby PWM ESC + motor (not a CyCAN board): what a servo-board channel drives on
 * thruster/propeller slots. Pulse 0 means no signal (motor off).
 */
export class PwmEsc implements MotorDriver {
  pulseUs = 0;
  bidirectional: boolean;
  feed: PowerFeed | null = null;
  supplyCurrent = 0;
  readonly motor: Motor;

  constructor(motor: Motor, bidirectional: boolean) {
    this.motor = motor;
    this.bidirectional = bidirectional;
    motor.driver = this;
  }

  drive(m: Motor, _sub: number): void {
    const vbus = this.feed ? this.feed.voltage : 0;
    const p = this.pulseUs;
    if (p < 800 || vbus < 5) {
      m.coast = true;
      m.voltage = 0;
      this.supplyCurrent = 0.02;
      return;
    }
    let duty = this.bidirectional ? (p - 1500) / 400 : (p - 1100) / 800;
    if (Math.abs(duty) < 0.02 || (!this.bidirectional && duty < 0)) duty = 0;
    duty = Math.max(-1, Math.min(1, duty));
    m.coast = false;
    const e = m.ke * m.omega;
    const ilim = 30 * m.spec.resistance;
    m.voltage = Math.max(e - ilim, Math.min(e + ilim, duty * vbus));
    this.supplyCurrent = 0.05 + Math.max(0, (m.current * m.voltage) / vbus);
  }
}

/** Hobby servo on a servo-board channel; optionally positions a shaft kinematically. */
export class HobbyServo {
  /** Output angle, degrees (±90 for 1000..2000 µs). */
  angleDeg = 0;
  /** °/s at no load. */
  speedDps = 500;
  current = 0;
  constructor(public shaft: Shaft | null = null) {}

  update(pulseUs: number, railV: number, dtS: number): void {
    if (pulseUs < 400 || railV < 3.5) {
      this.current = 0.005;
      if (this.shaft) this.shaft.handActive = false;
      return;
    }
    const target = ((pulseUs - 1500) / 500) * 90;
    const err = target - this.angleDeg;
    const maxStep = this.speedDps * (railV / 6) * dtS;
    const blocked = this.shaft !== null && this.shaft.jammed;
    const step = blocked ? 0 : Math.max(-maxStep, Math.min(maxStep, err * 0.6));
    this.angleDeg += step;
    const moving = Math.abs(step) / (dtS * this.speedDps);
    // Holding against a jam or a gravity load costs current; moving costs more.
    const holding = blocked && Math.abs(err) > 2 ? 1.6 : this.shaft?.gravity ? 0.25 : 0.02;
    this.current = 0.008 + 0.7 * Math.min(1, moving) + holding;
    if (this.shaft) {
      this.shaft.handActive = true;
      this.shaft.handOmega = ((step / dtS) * Math.PI) / 180;
      this.shaft.handUntil = -1;
    }
  }
}

// ---------------------------------------------------------------------------------------
// Body (vehicle chassis): feeds the gyro

export interface Thruster {
  shaft: Shaft;
  /** Body position, m; +x right, +y forward. */
  x: number;
  y: number;
  headingDeg: number;
  vertical: boolean;
  /** Propeller rotation sense for reaction torque: +1 cw, −1 ccw. */
  spin: number;
}

export type BodyConfig =
  | { kind: 'static' }
  | { kind: 'differential'; left: Shaft[]; right: Shaft[]; wheelRadiusM: number; trackM: number; slip?: number }
  | { kind: 'swerve'; wheelRadiusM: number; modules: Array<{ x: number; y: number; drive: Shaft; steer: Shaft }> }
  | { kind: 'mecanum'; wheelRadiusM: number; lx: number; ly: number; fl: Shaft; fr: Shaft; rl: Shaft; rr: Shaft }
  | { kind: 'thrust'; medium: 'air' | 'water' | 'surface'; massKg: number; thrusters: Thruster[] }
  | { kind: 'ackermann'; drive: Shaft[]; steer: Shaft; wheelRadiusM: number; wheelbaseM: number; maxSteerDeg: number }
  | { kind: 'turret'; pan: Shaft; tilt: Shaft | null };

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

export class Body {
  config: BodyConfig;
  /** Degrees; yaw counter-clockwise positive, pitch nose-up positive, roll right-side-down positive. */
  yaw = 0;
  pitch = 0;
  roll = 0;
  yawRate = 0;
  pitchRate = 0;
  rollRate = 0;
  /** Manual tilt the user holds the vehicle at (added to the model's pitch/roll). */
  manualPitch = 0;
  manualRoll = 0;
  /** Manual yaw rate (turning the robot by hand) and when it ends. */
  manualYawRate = 0;
  manualYawUntil = -1;
  airborne = false;
  private modelPitch = 0;
  private modelRoll = 0;
  private prevPitch = 0;
  private prevRoll = 0;

  constructor(config: BodyConfig = { kind: 'static' }) {
    this.config = config;
  }

  step(dtS: number, nowMs: number): void {
    const c = this.config;
    let modelYawRate = 0;
    switch (c.kind) {
      case 'static':
        break;
      case 'differential': {
        const vl = avgOmega(c.left) * c.wheelRadiusM;
        const vr = avgOmega(c.right) * c.wheelRadiusM;
        modelYawRate = ((vr - vl) / c.trackM) * (c.slip ?? 0.8) * R2D;
        break;
      }
      case 'swerve': {
        let num = 0;
        let den = 0;
        for (const m of c.modules) {
          const v = m.drive.omega * c.wheelRadiusM;
          const a = m.steer.angle;
          const vx = v * Math.sin(a);
          const vy = v * Math.cos(a);
          num += m.x * vy - m.y * vx;
          den += m.x * m.x + m.y * m.y;
        }
        modelYawRate = den > 0 ? (num / den) * R2D : 0;
        break;
      }
      case 'mecanum': {
        const r = c.wheelRadiusM;
        modelYawRate = ((r * (-c.fl.omega + c.fr.omega - c.rl.omega + c.rr.omega)) / (4 * (c.lx + c.ly))) * R2D;
        break;
      }
      case 'ackermann': {
        const v = avgOmega(c.drive) * c.wheelRadiusM;
        const d = clamp(c.steer.rot * 360, -c.maxSteerDeg, c.maxSteerDeg) * D2R;
        modelYawRate = ((v * Math.tan(d)) / c.wheelbaseM) * R2D;
        break;
      }
      case 'thrust':
        modelYawRate = this.thrustStep(c, dtS);
        break;
      case 'turret':
        this.yaw = c.pan.rot * 360;
        this.yawRate = c.pan.rpm * 6;
        this.modelPitch = c.tilt ? c.tilt.rot * 360 : 0;
        break;
    }
    if (c.kind !== 'turret') {
      if (this.manualYawUntil >= 0 && nowMs >= this.manualYawUntil) {
        this.manualYawRate = 0;
        this.manualYawUntil = -1;
      }
      this.yawRate = modelYawRate + this.manualYawRate;
      this.yaw += this.yawRate * dtS;
    }
    const p = this.modelPitch + this.manualPitch;
    const r = this.modelRoll + this.manualRoll;
    this.pitchRate = (p - this.prevPitch) / dtS;
    this.rollRate = (r - this.prevRoll) / dtS;
    this.prevPitch = p;
    this.prevRoll = r;
    this.pitch = p;
    this.roll = r;
  }

  private thrustYawRate = 0;

  /** Light attitude response to thrust imbalance: damped, with a restoring moment. */
  private thrustStep(c: Extract<BodyConfig, { kind: 'thrust' }>, dtS: number): number {
    let tz = 0;
    let tPitch = 0;
    let tRoll = 0;
    let lift = 0;
    for (const t of c.thrusters) {
      const f = t.shaft.thrust;
      // Reaction of the propeller drag turns the body the other way.
      tz -= t.shaft.propTorque;
      if (t.vertical) {
        lift += f;
        tPitch += t.y * f;
        tRoll -= t.x * f;
      } else {
        const h = t.headingDeg * D2R;
        const fx = f * Math.sin(h);
        const fy = f * Math.cos(h);
        tz += t.x * fy - t.y * fx;
      }
    }
    const inertia = Math.max(0.01, c.massKg * 0.02);
    let yawDamp = c.medium === 'air' ? 1.5 : 3;
    let restoring = c.medium === 'air' ? 40 : 25;
    if (c.medium === 'air') {
      this.airborne = lift > c.massKg * GRAVITY;
      if (!this.airborne) {
        yawDamp = 60;
        restoring = 4000;
      }
    }
    // Yaw: torque against linear drag.
    this.thrustYawRate += (tz / inertia - yawDamp * this.thrustYawRate) * dtS;
    // Pitch/roll: second order, steady tilt = torque / (I·k), kept to a few tens of degrees.
    const damp = 2 * Math.sqrt(restoring);
    this.pitchVel += (tPitch / inertia - damp * this.pitchVel - restoring * this.modelPitch * D2R) * dtS;
    this.rollVel += (tRoll / inertia - damp * this.rollVel - restoring * this.modelRoll * D2R) * dtS;
    this.modelPitch = clamp(this.modelPitch + this.pitchVel * dtS * R2D, -35, 35);
    this.modelRoll = clamp(this.modelRoll + this.rollVel * dtS * R2D, -35, 35);
    return this.thrustYawRate * R2D;
  }

  private pitchVel = 0;
  private rollVel = 0;
}

function avgOmega(s: Shaft[]): number {
  if (s.length === 0) return 0;
  let w = 0;
  for (const x of s) w += x.omega;
  return w / s.length;
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

// ---------------------------------------------------------------------------------------

export interface ShaftSnapshot {
  id: string;
  label: string;
  rot: number;
  rpm: number;
  torqueNm: number;
  loadNm: number;
  thrustN: number;
  hand: boolean;
  jammed: boolean;
}

export interface BodySnapshot {
  kind: BodyConfig['kind'];
  yawDeg: number;
  pitchDeg: number;
  rollDeg: number;
  yawRateDps: number;
  airborne: boolean;
}

/** The mechanical world: shafts, motors, battery, chassis. Advanced by the Simulation. */
export class World {
  readonly shafts: Shaft[] = [];
  readonly motors: Motor[] = [];
  readonly pwmEscs: PwmEsc[] = [];
  readonly servos: HobbyServo[] = [];
  readonly battery = new Battery();
  body = new Body();
  ambientC = 25;

  constructor(private readonly rng: Prng) {}

  addShaft(o: ShaftOptions): Shaft {
    if (this.shafts.some((s) => s.id === o.id)) throw new Error(`duplicate shaft id ${o.id}`);
    const s = new Shaft(o);
    this.shafts.push(s);
    return s;
  }

  shaft(id: string): Shaft {
    const s = this.shafts.find((x) => x.id === id);
    if (!s) throw new Error(`unknown shaft ${id}`);
    return s;
  }

  /** Couples a motor to a shaft; `gear` = motor turns per shaft turn. */
  addMotor(spec: MotorSpec, shaft: Shaft, gear = 1): Motor {
    const m = new Motor(spec, shaft, gear, this.rng);
    this.motors.push(m);
    shaft.motors.push(m);
    shaft.recompute();
    return m;
  }

  removeMotor(m: Motor): void {
    const i = this.motors.indexOf(m);
    if (i >= 0) this.motors.splice(i, 1);
    const j = m.shaft.motors.indexOf(m);
    if (j >= 0) m.shaft.motors.splice(j, 1);
    m.shaft.recompute();
  }

  addPwmEsc(motor: Motor, bidirectional = true): PwmEsc {
    const e = new PwmEsc(motor, bidirectional);
    this.pwmEscs.push(e);
    return e;
  }

  setBody(config: BodyConfig): Body {
    this.body = new Body(config);
    return this.body;
  }

  /** One substep of electrical + mechanical integration. */
  substep(sub: number): void {
    const ms = this.motors;
    for (let i = 0; i < ms.length; i++) {
      const m = ms[i]!;
      if (m.driver) m.driver.drive(m, sub);
      else {
        m.coast = true;
        m.voltage = 0;
      }
      m.electrical();
    }
    const ss = this.shafts;
    for (let i = 0; i < ss.length; i++) ss[i]!.substep(SUBSTEP_S);
  }

  /** Per-millisecond bookkeeping after the substeps. */
  finishStep(nowMs: number): void {
    const ms = this.motors;
    for (let i = 0; i < ms.length; i++) ms[i]!.thermal(0.001, this.ambientC);
    const ss = this.shafts;
    for (let i = 0; i < ss.length; i++) {
      const s = ss[i]!;
      if (s.disturbanceUntil >= 0 && nowMs >= s.disturbanceUntil) {
        s.disturbance = 0;
        s.disturbanceUntil = -1;
      }
      if (s.handActive && s.handUntil >= 0 && nowMs >= s.handUntil) {
        // A timed hand move ends with the hand stopping the shaft, then letting go.
        s.omega = 0;
        s.handActive = false;
        s.handUntil = -1;
      }
    }
    this.body.step(0.001, nowMs);
  }

  // ---- hand-of-god API -------------------------------------------------------------------

  /** Turns a shaft by hand at `rpm` for `durationMs` (−1 = until released). */
  handTurn(shaftId: string, rpm: number, nowMs: number, durationMs = -1): void {
    const s = this.shaft(shaftId);
    s.handActive = true;
    s.handOmega = rpm / RPM_PER_RADS;
    s.handUntil = durationMs < 0 ? -1 : nowMs + durationMs;
  }

  /** Rotates a shaft by `deltaRot` turns over `durationMs` (smooth hand move). */
  handRotate(shaftId: string, deltaRot: number, nowMs: number, durationMs = 300): void {
    const d = Math.max(1, durationMs);
    this.handTurn(shaftId, (deltaRot / (d / 1000)) * 60, nowMs, d);
  }

  /** Holds a shaft still by hand (−1 = until released). */
  handHold(shaftId: string, nowMs: number, durationMs = -1): void {
    this.handTurn(shaftId, 0, nowMs, durationMs);
  }

  handRelease(shaftId: string): void {
    const s = this.shaft(shaftId);
    s.handActive = false;
    s.handUntil = -1;
  }

  setLoad(shaftId: string, torqueNm: number): void {
    this.shaft(shaftId).load = torqueNm;
  }

  /** Step disturbance torque for `durationMs` (−1 = until cleared with 0). */
  push(shaftId: string, torqueNm: number, nowMs: number, durationMs = 200): void {
    const s = this.shaft(shaftId);
    s.disturbance = torqueNm;
    s.disturbanceUntil = durationMs < 0 ? -1 : nowMs + durationMs;
  }

  setJammed(shaftId: string, jammed: boolean): void {
    this.shaft(shaftId).jammed = jammed;
  }

  /** Holds the vehicle tilted (degrees). */
  tiltBody(pitchDeg: number, rollDeg: number): void {
    this.body.manualPitch = pitchDeg;
    this.body.manualRoll = rollDeg;
  }

  /** Turns the vehicle by hand at `dps` for `durationMs`. */
  spinBody(dps: number, nowMs: number, durationMs = 1000): void {
    this.body.manualYawRate = dps;
    this.body.manualYawUntil = durationMs < 0 ? -1 : nowMs + durationMs;
  }

  snapshotShafts(): ShaftSnapshot[] {
    return this.shafts.map((s) => ({
      id: s.id,
      label: s.label,
      rot: s.rot,
      rpm: s.rpm,
      torqueNm: s.netTorque,
      loadNm: s.load + s.disturbance,
      thrustN: s.thrust,
      hand: s.handActive,
      jammed: s.jammed,
    }));
  }

  snapshotBody(): BodySnapshot {
    const b = this.body;
    return { kind: b.config.kind, yawDeg: b.yaw, pitchDeg: b.pitch, rollDeg: b.roll, yawRateDps: b.yawRate, airborne: b.airborne };
  }
}
