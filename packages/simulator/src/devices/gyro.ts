import { CommandStatus, GyroCalStatus, Model, bitsToF32 } from '@cygnus/protocol';
import { NodeMode, SimNode, type SimNodeOptions } from '../node';
import type { Body } from '../world';

const SIGNAL_KEYS = [
  'yaw',
  'pitch',
  'roll',
  'gyro.x',
  'gyro.y',
  'gyro.z',
  'accel.x',
  'accel.y',
  'accel.z',
  'quat.w',
  'quat.x',
  'quat.y',
  'quat.z',
  'temp',
  'cal.status',
] as const;
const S_YAW = 0;
const S_PITCH = 1;
const S_ROLL = 2;
const S_GYRO_X = 3;
const S_GYRO_Y = 4;
const S_GYRO_Z = 5;
const S_ACCEL_X = 6;
const S_ACCEL_Y = 7;
const S_ACCEL_Z = 8;
const S_QUAT_W = 9;
const S_QUAT_X = 10;
const S_QUAT_Y = 11;
const S_QUAT_Z = 12;
const S_TEMP = 13;
const S_CAL_STATUS = 14;

// Parameter slots, resolved to table indices once per board.
const PARAM_KEYS = [
  'mount.yaw_deg',
  'mount.pitch_deg',
  'mount.roll_deg',
  'fusion.mode',
  'fusion.cal_on_boot',
  'fusion.cal_time_s',
  'fusion.motion_dps',
  'fusion.yaw_invert',
  'fusion.yaw_wrap',
  'imu.gyro_range',
  'imu.accel_range',
  'imu.lpf_hz',
] as const;
const P_MOUNT_YAW_DEG = 0;
const P_MOUNT_PITCH_DEG = 1;
const P_MOUNT_ROLL_DEG = 2;
const P_FUSION_MODE = 3;
const P_FUSION_CAL_ON_BOOT = 4;
const P_FUSION_CAL_TIME_S = 5;
const P_FUSION_MOTION_DPS = 6;
const P_FUSION_YAW_INVERT = 7;
const P_FUSION_YAW_WRAP = 8;
const P_IMU_GYRO_RANGE = 9;
const P_IMU_ACCEL_RANGE = 10;
const P_IMU_LPF_HZ = 11;

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
  private readonly P: Int32Array;
  private readonly S: Int32Array;

  constructor(o: GyroOptions = {}) {
    super(Model.GYRO, o);
    this.body = o.body ?? null;
    this.biasSigma = o.biasDps ?? 0.35;
    this.P = Int32Array.from(PARAM_KEYS, (k) => this.params.index(k));
    this.S = Int32Array.from(SIGNAL_KEYS, (k) => this.sigIndex(k));
  }

  private pk(i: number): number {
    return this.p(this.P[i]!);
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
    if (this.pk(P_FUSION_CAL_ON_BOOT)) this.startCal(false);
  }

  private startCal(fromCommand: boolean): void {
    this.calStatus = GyroCalStatus.RUNNING;
    this.calUntil = this.now + this.pk(P_FUSION_CAL_TIME_S) * 1000;
    this.calMaxRate = 0;
    this.calFromCommand = fromCommand;
  }

  protected override appTick(): void {
    const b = this.b;
    const dt = 0.001;
    // Bias random walk (in-run instability).
    for (let k = 0; k < 3; k++) this.bias[k] = this.bias[k]! + this.rng.gauss() * 0.0004;
    const lpf = this.pk(P_IMU_LPF_HZ);
    const noise = 0.012 * Math.sqrt(lpf);
    const range = this.pk(P_IMU_GYRO_RANGE);
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
      if (this.pk(P_FUSION_MODE) === 1) this.yawInt += (b.yaw - this.yawRef - this.yawInt) * (dt / 20);
    }

    const inv = this.pk(P_FUSION_YAW_INVERT) ? -1 : 1;
    let yaw = inv * (this.yawInt - this.pk(P_MOUNT_YAW_DEG));
    if (this.pk(P_FUSION_YAW_WRAP) === 1) yaw = ((((yaw + 180) % 360) + 360) % 360) - 180;
    const pitch = b.pitch - this.pk(P_MOUNT_PITCH_DEG) + this.rng.gauss() * 0.02;
    const roll = b.roll - this.pk(P_MOUNT_ROLL_DEG) + this.rng.gauss() * 0.02;
    const s = this.sig;
    const S = this.S;
    s[S[S_YAW]!] = yaw;
    s[S[S_PITCH]!] = pitch;
    s[S[S_ROLL]!] = roll;
    s[S[S_GYRO_X]!] = meas[0]!;
    s[S[S_GYRO_Y]!] = meas[1]!;
    s[S[S_GYRO_Z]!] = inv * meas[2]!;
    const pr = b.pitch * D2R;
    const rr = b.roll * D2R;
    const an = 0.002;
    const ar = this.pk(P_IMU_ACCEL_RANGE);
    s[S[S_ACCEL_X]!] = clampAbs(Math.sin(pr) + this.rng.gauss() * an, ar);
    s[S[S_ACCEL_Y]!] = clampAbs(-Math.sin(rr) * Math.cos(pr) + this.rng.gauss() * an, ar);
    s[S[S_ACCEL_Z]!] = clampAbs(Math.cos(pr) * Math.cos(rr) + this.rng.gauss() * an, ar);
    // ZYX (yaw, pitch, roll) to quaternion.
    const cy = Math.cos((yaw * D2R) / 2);
    const sy = Math.sin((yaw * D2R) / 2);
    const cp = Math.cos((pitch * D2R) / 2);
    const sp = Math.sin((pitch * D2R) / 2);
    const cr = Math.cos((roll * D2R) / 2);
    const sr = Math.sin((roll * D2R) / 2);
    s[S[S_QUAT_W]!] = cr * cp * cy + sr * sp * sy;
    s[S[S_QUAT_X]!] = sr * cp * cy - cr * sp * sy;
    s[S[S_QUAT_Y]!] = cr * sp * cy + sr * cp * sy;
    s[S[S_QUAT_Z]!] = cr * cp * sy - sr * sp * cy;
    this.temp += (36 - this.temp) * 0.00005;
    s[S[S_TEMP]!] = this.temp;
    s[S[S_CAL_STATUS]!] = this.calStatus;
  }

  private finishCal(): void {
    const moved = this.calMaxRate > this.pk(P_FUSION_MOTION_DPS);
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
        const inv = this.pk(P_FUSION_YAW_INVERT) ? -1 : 1;
        this.yawInt = inv * v + this.pk(P_MOUNT_YAW_DEG);
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

function clampAbs(v: number, lim: number): number {
  return v > lim ? lim : v < -lim ? -lim : v;
}
