import { CommandStatus, GyroCalStatus, Model, bitsToF32 } from '@cygnus/protocol';
import { NodeMode, SimNode, type SimNodeOptions } from '../node';
import type { Body } from '../world';

const F = { CAL_MOTION: 10, SATURATION: 11 } as const;
const D2R = Math.PI / 180;

export interface GyroOptions extends SimNodeOptions {
  /** Body the board is mounted on; defaults to the world's body at attach time. */
  body?: Body | null;
  /** Initial gyro bias magnitude, dps (σ). */
  biasDps?: number;
}

/**
 * CAN gyro: reads the chassis attitude, adds bias (random walk), noise and saturation.
 * Yaw is integrated from the rate, so an uncalibrated bias shows up as drift.
 */
export class GyroNode extends SimNode {
  private body: Body | null;
  private readonly biasSigma: number;
  private bias = [0, 0, 0];
  private biasEst = [0, 0, 0];
  private yawInt = 0;
  private yawRef = 0;
  private calStatus: number = GyroCalStatus.NONE;
  private calUntil = -1;
  private calMaxRate = 0;
  private calFromCommand = false;
  private temp = 31;
  private readonly P: Record<string, number>;
  private readonly S: Record<string, number>;

  constructor(o: GyroOptions = {}) {
    super(Model.GYRO, o);
    this.body = o.body ?? null;
    this.biasSigma = o.biasDps ?? 0.35;
    const keys = ['mount.yaw_deg', 'mount.pitch_deg', 'mount.roll_deg', 'fusion.mode', 'fusion.cal_on_boot', 'fusion.cal_time_s',
      'fusion.motion_dps', 'fusion.yaw_invert', 'fusion.yaw_wrap', 'imu.gyro_range', 'imu.accel_range', 'imu.lpf_hz'];
    this.P = Object.fromEntries(keys.map((k) => [k, this.params.index(k)]));
    const sigs = ['yaw', 'pitch', 'roll', 'gyro.x', 'gyro.y', 'gyro.z', 'accel.x', 'accel.y', 'accel.z', 'quat.w', 'quat.x', 'quat.y',
      'quat.z', 'temp', 'cal.status'];
    this.S = Object.fromEntries(sigs.map((k) => [k, this.sigIndex(k)]));
  }

  private pk(k: string): number {
    return this.p(this.P[k]!);
  }

  private get b(): Body {
    return this.body ?? this.ctx.world.body;
  }

  protected override onAttach(): void {
    this.bias = [this.rng.gauss() * this.biasSigma, this.rng.gauss() * this.biasSigma, this.rng.gauss() * this.biasSigma];
  }

  protected override onAppStart(): void {
    this.biasEst = [0, 0, 0];
    this.yawInt = 0;
    this.yawRef = this.b.yaw;
    this.calStatus = GyroCalStatus.NONE;
    this.calUntil = -1;
    if (this.pk('fusion.cal_on_boot')) this.startCal(false);
  }

  private startCal(fromCommand: boolean): void {
    this.calStatus = GyroCalStatus.RUNNING;
    this.calUntil = this.now + this.pk('fusion.cal_time_s') * 1000;
    this.calMaxRate = 0;
    this.calFromCommand = fromCommand;
  }

  protected override appTick(): void {
    const b = this.b;
    const dt = 0.001;
    // Bias random walk (in-run instability).
    for (let k = 0; k < 3; k++) this.bias[k] = this.bias[k]! + this.rng.gauss() * 0.0004;
    const lpf = this.pk('imu.lpf_hz');
    const noise = 0.012 * Math.sqrt(lpf);
    const range = this.pk('imu.gyro_range');
    const trueRates = [b.rollRate, b.pitchRate, b.yawRate];
    let saturated = false;
    const meas = [0, 0, 0];
    for (let k = 0; k < 3; k++) {
      let r = trueRates[k]! + this.bias[k]! - this.biasEst[k]! + this.rng.gauss() * noise;
      if (Math.abs(r) > range) {
        saturated = true;
        r = Math.sign(r) * range;
      }
      meas[k] = r;
    }
    this.setFault(F.SATURATION, saturated);

    if (this.calStatus === GyroCalStatus.RUNNING) {
      for (let k = 0; k < 3; k++) this.calMaxRate = Math.max(this.calMaxRate, Math.abs(trueRates[k]!));
      if (this.now >= this.calUntil) this.finishCal();
    } else {
      this.yawInt += meas[2]! * dt;
      // 9-axis fusion pulls yaw towards the magnetometer heading.
      if (this.pk('fusion.mode') === 1) this.yawInt += (b.yaw - this.yawRef - this.yawInt) * (dt / 20);
    }

    const inv = this.pk('fusion.yaw_invert') ? -1 : 1;
    let yaw = inv * (this.yawInt - this.pk('mount.yaw_deg'));
    if (this.pk('fusion.yaw_wrap') === 1) yaw = ((((yaw + 180) % 360) + 360) % 360) - 180;
    const pitch = b.pitch - this.pk('mount.pitch_deg') + this.rng.gauss() * 0.02;
    const roll = b.roll - this.pk('mount.roll_deg') + this.rng.gauss() * 0.02;
    const s = this.sig;
    const S = this.S;
    s[S['yaw']!] = yaw;
    s[S['pitch']!] = pitch;
    s[S['roll']!] = roll;
    s[S['gyro.x']!] = meas[0]!;
    s[S['gyro.y']!] = meas[1]!;
    s[S['gyro.z']!] = inv * meas[2]!;
    const pr = b.pitch * D2R;
    const rr = b.roll * D2R;
    const an = 0.002;
    s[S['accel.x']!] = Math.sin(pr) + this.rng.gauss() * an;
    s[S['accel.y']!] = -Math.sin(rr) * Math.cos(pr) + this.rng.gauss() * an;
    s[S['accel.z']!] = Math.cos(pr) * Math.cos(rr) + this.rng.gauss() * an;
    // ZYX (yaw, pitch, roll) to quaternion.
    const cy = Math.cos((yaw * D2R) / 2);
    const sy = Math.sin((yaw * D2R) / 2);
    const cp = Math.cos((pitch * D2R) / 2);
    const sp = Math.sin((pitch * D2R) / 2);
    const cr = Math.cos((roll * D2R) / 2);
    const sr = Math.sin((roll * D2R) / 2);
    s[S['quat.w']!] = cr * cp * cy + sr * sp * sy;
    s[S['quat.x']!] = sr * cp * cy - cr * sp * sy;
    s[S['quat.y']!] = cr * sp * cy + sr * cp * sy;
    s[S['quat.z']!] = cr * cp * sy - sr * sp * cy;
    this.temp += (36 - this.temp) * 0.00005;
    s[S['temp']!] = this.temp;
    s[S['cal.status']!] = this.calStatus;
  }

  private finishCal(): void {
    const moved = this.calMaxRate > this.pk('fusion.motion_dps');
    if (moved) {
      this.calStatus = GyroCalStatus.FAILED_MOTION;
      this.setFault(F.CAL_MOTION, true);
    } else {
      this.calStatus = GyroCalStatus.DONE;
      this.setFault(F.CAL_MOTION, false);
      for (let k = 0; k < 3; k++) this.biasEst[k] = this.bias[k]! + this.rng.gauss() * 0.004;
    }
    this.calUntil = -1;
    if (this.calFromCommand) this.completeCommand(0x40, moved ? CommandStatus.FAILED : CommandStatus.OK, moved ? 1 : 0);
  }

  protected override action(cmd: number, arg: number): { status: number; result: number } {
    switch (cmd) {
      case 0x40:
        this.startCal(true);
        return { status: CommandStatus.IN_PROGRESS, result: 0 };
      case 0x41: {
        const v = bitsToF32(arg);
        if (!Number.isFinite(v)) return { status: CommandStatus.INVALID_ARG, result: 0 };
        const inv = this.pk('fusion.yaw_invert') ? -1 : 1;
        this.yawInt = inv * v + this.pk('mount.yaw_deg');
        return { status: CommandStatus.OK, result: 0 };
      }
      case 0x42:
        this.params.setKey('mount.pitch_deg', this.b.pitch);
        this.params.setKey('mount.roll_deg', this.b.roll);
        return { status: CommandStatus.OK, result: 0 };
    }
    return { status: CommandStatus.UNSUPPORTED, result: 0 };
  }

  override supplyCurrent(): number {
    return this.mode === NodeMode.OFF ? 0 : 0.035;
  }

  /** True bias (dps) — for tests and the panel's "behind the scenes" view. */
  get trueBias(): readonly number[] {
    return this.bias;
  }
}
