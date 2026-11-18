import { CommandStatus, FaultBit, Model, SERVO16_CHANNELS, readU16 } from '@cygnus/protocol';
import { NodeMode, SimNode, type InjectionKind, type SimNodeOptions } from '../node';
import { HobbyServo } from '../world';

/** What a channel's pulse train drives: a hobby servo, or any PWM input (`{ pulseUs }`). */
export type ChannelSink = { kind: 'servo'; servo: HobbyServo } | { kind: 'pwm'; target: { pulseUs: number } };

export interface Servo16Options extends SimNodeOptions {
  /** Sinks by channel number (1..16). */
  sinks?: Partial<Record<number, ChannelSink>>;
}

const RAIL_V = 6;
const RAIL_TRIP_A = 15;
const F_RAIL_OC = 10;

/** 16-channel servo controller: per-channel limits, inversion, slew limit, failsafe; 6 V servo rail. */
export class Servo16Node extends SimNode {
  readonly sinks: (ChannelSink | null)[] = [];
  /** Commanded pulse per channel (0 = off). */
  private readonly target = new Float64Array(SERVO16_CHANNELS);
  /** Output pulse after limits and slew (0 = off). */
  private readonly out = new Float64Array(SERVO16_CHANNELS);
  private railV = 0;
  private railA = 0;
  private railTripped = false;
  private forceOc = false;
  private temp = 30;
  private readonly chP: Array<{ en: number; min: number; ctr: number; max: number; fs: number; inv: number; spd: number }>;
  private readonly chS: number[];
  private readonly sRailV: number;
  private readonly sRailA: number;
  private readonly sTemp: number;
  private readonly pUv: number;

  constructor(o: Servo16Options = {}) {
    super(Model.SERVO_16CH, o);
    for (let c = 1; c <= SERVO16_CHANNELS; c++) this.sinks.push(o.sinks?.[c] ?? null);
    this.chP = Array.from({ length: SERVO16_CHANNELS }, (_, i) => {
      const k = (s: string): number => this.params.index(`ch.${i + 1}.${s}`);
      return { en: k('enable'), min: k('min_us'), ctr: k('center_us'), max: k('max_us'), fs: k('failsafe_us'), inv: k('invert'), spd: k('speed_us_s') };
    });
    this.chS = Array.from({ length: SERVO16_CHANNELS }, (_, i) => this.sigIndex(`ch.${i + 1}.pulse`));
    this.sRailV = this.sigIndex('rail.voltage');
    this.sRailA = this.sigIndex('rail.current');
    this.sTemp = this.sigIndex('temp');
    this.pUv = this.params.index('servo.rail_uv_warn_v');
  }

  setSink(channel: number, sink: ChannelSink | null): void {
    this.sinks[channel - 1] = sink;
  }

  protected override onAppStart(): void {
    this.target.fill(0);
    this.out.fill(0);
  }

  protected override onAppStop(): void {
    this.target.fill(0);
    this.out.fill(0);
    this.pushOutputs(0.001);
  }

  protected override onCtrl(index: number, d: Uint8Array, len: number): boolean {
    if (index > 3 || len < 8) return false;
    for (let k = 0; k < 4; k++) this.target[index * 4 + k] = readU16(d, 2 * k);
    return true;
  }

  /** Timeout / ESTOP: every channel goes to its failsafe pulse (0 = stop pulsing). */
  protected override neutral(): void {
    for (let c = 0; c < SERVO16_CHANNELS; c++) this.target[c] = this.p(this.chP[c]!.fs);
  }

  override isEnabled(): boolean {
    if (this.mode !== NodeMode.APP || this.estopped) return false;
    for (let c = 0; c < SERVO16_CHANNELS; c++) if (this.out[c]! > 0) return true;
    return false;
  }

  /** Commanded pulse → limits and inversion; 0 stays 0 (channel off). */
  private shape(c: number, p: number): number {
    const P = this.chP[c]!;
    if (p <= 0 || this.p(P.en) === 0) return 0;
    const min = this.p(P.min);
    const max = this.p(P.max);
    const ctr = this.p(P.ctr);
    let v = Math.min(max, Math.max(min, p));
    if (this.p(P.inv)) v = Math.min(max, Math.max(min, 2 * ctr - v));
    return v;
  }

  protected override appTick(): void {
    const dt = 0.001;
    const unassignedOrStopped = !this.assigned || this.estopped;
    for (let c = 0; c < SERVO16_CHANNELS; c++) {
      const want = unassignedOrStopped ? (this.estopped ? this.shape(c, this.p(this.chP[c]!.fs)) : 0) : this.shape(c, this.target[c]!);
      const spd = this.p(this.chP[c]!.spd);
      const cur = this.out[c]!;
      if (want === 0 || cur === 0 || spd <= 0) this.out[c] = want;
      else this.out[c] = cur + Math.max(-spd * dt, Math.min(spd * dt, want - cur));
      this.sig[this.chS[c]!] = this.out[c]!;
    }
    this.pushOutputs(dt);
    if (this.railA > RAIL_TRIP_A || this.forceOc) this.railTripped = true;
    this.setFault(F_RAIL_OC, this.railTripped);
    this.setWarn(FaultBit.UNDERVOLT, this.railV < this.p(this.pUv));
    this.temp += (30 + this.railA * 1.5 - this.temp) * 0.0003;
    this.sig[this.sRailV] = this.railV + this.rng.gauss() * 0.005;
    this.sig[this.sRailA] = this.railA;
    this.sig[this.sTemp] = this.temp;
  }

  private pushOutputs(dt: number): void {
    const on = this.mode === NodeMode.APP && !this.railTripped;
    const vin = this.supplyV;
    // Rail regulator: drops out below its input and sags with load.
    const v0 = on ? Math.min(RAIL_V, vin - 0.4) : 0;
    let amps = 0;
    for (let c = 0; c < SERVO16_CHANNELS; c++) {
      const s = this.sinks[c];
      if (!s) continue;
      const pulse = this.out[c]!;
      if (s.kind === 'servo') {
        s.servo.update(on ? pulse : 0, this.railV, dt);
        amps += s.servo.current;
      } else s.target.pulseUs = this.mode === NodeMode.APP ? pulse : 0;
    }
    this.railA = on ? amps : 0;
    this.railV = Math.max(0, v0 - 0.035 * this.railA);
  }

  override supplyCurrent(): number {
    if (this.mode === NodeMode.OFF) return 0;
    return 0.05 + (this.railV * this.railA) / (0.88 * Math.max(5, this.supplyV));
  }

  protected override onClearFaults(): void {
    if (!this.forceOc) this.railTripped = false;
  }

  protected override action(cmd: number): { status: number; result: number } {
    if (cmd === 0x40) {
      for (let c = 0; c < SERVO16_CHANNELS; c++) this.target[c] = this.p(this.chP[c]!.en) ? this.p(this.chP[c]!.ctr) : 0;
      return { status: CommandStatus.OK, result: 0 };
    }
    if (cmd === 0x41) {
      this.target.fill(0);
      return { status: CommandStatus.OK, result: 0 };
    }
    return { status: CommandStatus.UNSUPPORTED, result: 0 };
  }

  /** Output pulse of a channel (1..16), µs. */
  pulse(channel: number): number {
    return this.out[channel - 1] ?? 0;
  }

  override supportedInjections(): InjectionKind[] {
    return ['railOvercurrent'];
  }

  protected override injectModel(kind: InjectionKind, on: boolean): boolean {
    if (kind !== 'railOvercurrent') return false;
    this.forceOc = on;
    return true;
  }

  protected override activeModelInjections(): InjectionKind[] {
    return this.forceOc ? ['railOvercurrent'] : [];
  }
}
