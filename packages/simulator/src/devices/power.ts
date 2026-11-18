import { CommandStatus, FaultBit, Model } from '@cygnus/protocol';
import { NodeMode, SimNode, type InjectionKind, type SimNodeOptions } from '../node';
import type { PowerDistributor } from '../simulation';
import { PowerFeed } from '../world';

/** Blade fuse with an I²t-style heat accumulator. */
class Fuse {
  heat = 0;
  blown = false;
  constructor(public ratingA: number) {}

  update(a: number, dtS: number): void {
    if (this.blown) return;
    const x = (a * a) / (this.ratingA * this.ratingA);
    // Above rating heat builds (2× rating ≈ 0.3 s, 1.3× ≈ 1.5 s); below it cools off.
    this.heat = Math.max(0, this.heat + (x > 1 ? x - 1 : -0.5) * dtS);
    if (this.heat > 1) this.blown = true;
  }

  replace(): void {
    this.blown = false;
    this.heat = 0;
  }
}

export interface PdhOptions extends SimNodeOptions {
  /** Fuse ratings per channel, A (default 40). */
  fuseA?: number[];
  /** Constant loads on the auxiliary rails, A (radio, camera …). */
  aux5LoadA?: number;
  aux12LoadA?: number;
}

const PDH_F = { FUSE_BLOWN: 10, AUX_OVERCURRENT: 11 } as const;

/** Large power distribution board: 8 fused channels, 5 V / 12 V auxiliary outputs, energy meter. */
export class PdhLargeNode extends SimNode implements PowerDistributor {
  readonly channels: PowerFeed[];
  readonly fuses: Fuse[];
  aux5LoadA: number;
  aux12LoadA: number;
  private auxTripped = false;
  private auxFault = false;
  private energyWh = 0;
  private temp = 28;
  private readonly chanCurrent = new Float64Array(8);
  private readonly P: Record<string, number>;
  private readonly S: Record<string, number>;

  constructor(o: PdhOptions = {}) {
    super(Model.POWER_DIST_LARGE, o);
    this.channels = Array.from({ length: 8 }, (_, i) => new PowerFeed(`${this.id}.ch${i + 1}`, this));
    this.fuses = Array.from({ length: 8 }, (_, i) => new Fuse(o.fuseA?.[i] ?? 40));
    this.aux5LoadA = o.aux5LoadA ?? 0.25;
    this.aux12LoadA = o.aux12LoadA ?? 0.3;
    const keys = ['power.uv_warn_v', 'power.total_warn_a', 'aux.5v_enable', 'aux.12v_enable', ...Array.from({ length: 8 }, (_, i) => `ch.${i + 1}.warn_a`)];
    this.P = Object.fromEntries(keys.map((k) => [k, this.params.index(k)]));
    const sigs = ['input.voltage', 'total.current', 'fuse.mask', 'aux5.voltage', 'aux5.current', 'aux12.voltage', 'aux12.current', 'temp', 'energy', 'power',
      ...Array.from({ length: 8 }, (_, i) => `ch.${i + 1}.current`)];
    this.S = Object.fromEntries(sigs.map((k) => [k, this.sigIndex(k)]));
  }

  private pk(k: string): number {
    return this.p(this.P[k]!);
  }

  channel(n: number): PowerFeed {
    const f = this.channels[n - 1];
    if (!f) throw new Error(`PDH channel ${n} out of range`);
    return f;
  }

  replaceFuse(n: number): void {
    this.fuses[n - 1]?.replace();
  }

  private aux5On(): boolean {
    return this.mode === NodeMode.APP && this.pk('aux.5v_enable') !== 0 && !this.auxTripped;
  }

  private aux12On(): boolean {
    return this.mode === NodeMode.APP && this.pk('aux.12v_enable') !== 0 && !this.auxTripped;
  }

  override supplyCurrent(): number {
    if (this.mode === NodeMode.OFF) {
      // Channels are hard-wired through fuses: loads still draw with the controller off.
      let a = 0;
      for (const c of this.channels) a += c.load;
      return a;
    }
    let a = 0.08;
    for (const c of this.channels) a += c.load;
    const vin = Math.max(6, this.supplyV);
    if (this.aux5On()) a += (5 * this.aux5LoadA) / (0.9 * vin);
    if (this.aux12On()) a += (12 * this.aux12LoadA) / (0.9 * vin);
    return a;
  }

  distribute(dtS: number): void {
    const vin = this.supplyV;
    for (let i = 0; i < 8; i++) {
      const ch = this.channels[i]!;
      const fuse = this.fuses[i]!;
      fuse.update(ch.load, dtS);
      this.chanCurrent[i] = fuse.blown ? 0 : ch.load;
      ch.voltage = fuse.blown ? 0 : Math.max(0, vin - ch.load * 0.003);
    }
  }

  protected override appTick(): void {
    const vin = this.supplyV;
    let total = 0;
    let mask = 0;
    const s = this.sig;
    let chWarn = false;
    for (let i = 0; i < 8; i++) {
      const a = this.chanCurrent[i]!;
      total += a;
      if (this.fuses[i]!.blown) mask |= 1 << i;
      s[this.S[`ch.${i + 1}.current`]!] = Math.max(0, a + this.rng.gauss() * 0.03);
      const w = this.pk(`ch.${i + 1}.warn_a`);
      if (w > 0 && a > w) chWarn = true;
    }
    const a5 = this.aux5On() ? this.aux5LoadA : 0;
    const a12 = this.aux12On() ? this.aux12LoadA : 0;
    if ((a5 > 1.2 || a12 > 1.2) && !this.auxTripped) {
      this.auxTripped = true;
      this.auxFault = true;
    }
    total += (5 * a5 + 12 * a12) / (0.9 * Math.max(6, vin)) + 0.08;
    this.energyWh += (vin * total) / 3.6e6;
    this.temp += (28 + total * 0.12 - this.temp) * 0.0002;
    s[this.S['input.voltage']!] = vin + this.rng.gauss() * 0.01;
    s[this.S['total.current']!] = total;
    s[this.S['fuse.mask']!] = mask;
    s[this.S['aux5.voltage']!] = this.aux5On() ? 5.02 - a5 * 0.04 : 0;
    s[this.S['aux5.current']!] = a5;
    s[this.S['aux12.voltage']!] = this.aux12On() ? 12.05 - a12 * 0.06 : 0;
    s[this.S['aux12.current']!] = a12;
    s[this.S['temp']!] = this.temp;
    s[this.S['energy']!] = this.energyWh;
    s[this.S['power']!] = vin * total;
    this.setFault(PDH_F.FUSE_BLOWN, mask !== 0);
    this.setFault(PDH_F.AUX_OVERCURRENT, this.auxFault);
    this.setWarn(FaultBit.OVERCURRENT, chWarn || total > this.pk('power.total_warn_a'));
    this.setWarn(FaultBit.UNDERVOLT, vin < this.pk('power.uv_warn_v'));
  }

  protected override onClearFaults(): void {
    this.auxFault = false;
    this.auxTripped = false;
  }

  protected override action(cmd: number): { status: number; result: number } {
    if (cmd === 0x40) {
      this.energyWh = 0;
      return { status: CommandStatus.OK, result: 0 };
    }
    return { status: CommandStatus.UNSUPPORTED, result: 0 };
  }

  override supportedInjections(): InjectionKind[] {
    return ['fuseBlown', 'auxOvercurrent'];
  }

  /** `fuseBlown` takes the channel (1..8) as `arg`. */
  protected override injectModel(kind: InjectionKind, on: boolean, arg: number): boolean {
    if (kind === 'fuseBlown') {
      const f = this.fuses[(arg || 1) - 1];
      if (!f) return false;
      if (on) f.blown = true;
      else f.replace();
      return true;
    }
    if (kind === 'auxOvercurrent') {
      this.aux5LoadA = on ? 2 : 0.25;
      return true;
    }
    return false;
  }

  protected override activeModelInjections(): InjectionKind[] {
    const out: InjectionKind[] = [];
    if (this.fuses.some((f) => f.blown)) out.push('fuseBlown');
    if (this.aux5LoadA > 1.2) out.push('auxOvercurrent');
    return out;
  }
}

/** Small power distribution board: 4 fused outputs, 5 V and 12 V rails. */
export class PdhSmallNode extends SimNode implements PowerDistributor {
  readonly channels: PowerFeed[];
  readonly fuses: Fuse[];
  /** Load on the on-board 5 V / 12 V regulators, A. */
  rail5LoadA = 0.3;
  rail12LoadA = 0.2;
  private readonly chanCurrent = new Float64Array(4);
  private readonly S: Record<string, number>;
  private readonly pUv: number;

  constructor(o: PdhOptions = {}) {
    super(Model.POWER_DIST_SMALL, o);
    this.channels = Array.from({ length: 4 }, (_, i) => new PowerFeed(`${this.id}.ch${i + 1}`, this));
    this.fuses = Array.from({ length: 4 }, (_, i) => new Fuse(o.fuseA?.[i] ?? 30));
    this.pUv = this.params.index('power.uv_warn_v');
    const sigs = ['input.voltage', 'total.current', 'rail5.voltage', 'rail12.voltage', 'fuse.mask'];
    this.S = Object.fromEntries(sigs.map((k) => [k, this.sigIndex(k)]));
  }

  channel(n: number): PowerFeed {
    const f = this.channels[n - 1];
    if (!f) throw new Error(`PDH channel ${n} out of range`);
    return f;
  }

  replaceFuse(n: number): void {
    this.fuses[n - 1]?.replace();
  }

  override supplyCurrent(): number {
    let a = this.mode === NodeMode.OFF ? 0 : 0.05 + (5 * this.rail5LoadA + 12 * this.rail12LoadA) / (0.9 * Math.max(6, this.supplyV));
    for (const c of this.channels) a += c.load;
    return a;
  }

  distribute(dtS: number): void {
    const vin = this.supplyV;
    for (let i = 0; i < 4; i++) {
      const ch = this.channels[i]!;
      const fuse = this.fuses[i]!;
      fuse.update(ch.load, dtS);
      this.chanCurrent[i] = fuse.blown ? 0 : ch.load;
      ch.voltage = fuse.blown ? 0 : Math.max(0, vin - ch.load * 0.004);
    }
  }

  protected override appTick(): void {
    const vin = this.supplyV;
    let mask = 0;
    const total = this.supplyCurrent();
    for (let i = 0; i < 4; i++) if (this.fuses[i]!.blown) mask |= 1 << i;
    const s = this.sig;
    s[this.S['input.voltage']!] = vin + this.rng.gauss() * 0.01;
    s[this.S['total.current']!] = total;
    // 12 V rail is a buck: it falls out of regulation when the battery sags below ~13 V.
    s[this.S['rail5.voltage']!] = vin > 6 ? 5.0 - this.rail5LoadA * 0.03 : 0;
    s[this.S['rail12.voltage']!] = vin > 6 ? Math.min(12.0 - this.rail12LoadA * 0.04, vin - 0.9) : 0;
    s[this.S['fuse.mask']!] = mask;
    this.setFault(PDH_F.FUSE_BLOWN, mask !== 0);
    this.setWarn(FaultBit.UNDERVOLT, vin < this.p(this.pUv));
  }

  override supportedInjections(): InjectionKind[] {
    return ['fuseBlown'];
  }

  protected override injectModel(kind: InjectionKind, on: boolean, arg: number): boolean {
    if (kind !== 'fuseBlown') return false;
    const f = this.fuses[(arg || 1) - 1];
    if (!f) return false;
    if (on) f.blown = true;
    else f.replace();
    return true;
  }

  protected override activeModelInjections(): InjectionKind[] {
    return this.fuses.some((f) => f.blown) ? ['fuseBlown'] : [];
  }
}

export interface SocRegOptions extends SimNodeOptions {
  /** Output variant, V (5, 12 or 19). */
  outputV?: 5 | 12 | 19;
  /** Average load of the computer it powers, A. */
  loadA?: number;
}

const SOC_F = { OUTPUT_OVERCURRENT: 10, OUT_OF_REGULATION: 11 } as const;

/**
 * Buck-boost regulator for an on-board computer: ripple grows with load, brownouts are
 * counted, and the output sags out of regulation when input power runs short.
 */
export class SocRegNode extends SimNode implements PowerDistributor {
  /** Boards powered from the regulated output (rare; the computer is `loadA`). */
  readonly output: PowerFeed;
  loadA: number;
  private outV = 0;
  private outOn = false;
  private brownouts = 0;
  private ocLatched = false;
  private forceOc = false;
  private temp = 30;
  private spike = 0;
  private readonly P: Record<string, number>;
  private readonly S: Record<string, number>;

  constructor(o: SocRegOptions = {}) {
    super(Model.SOC_REGULATOR, { ...o, params: { 'reg.output_v': o.outputV ?? 12, ...o.params } });
    this.output = new PowerFeed(`${this.id}.out`, this);
    this.loadA = o.loadA ?? 1.8;
    const keys = ['reg.output_v', 'reg.uvlo_v', 'reg.current_warn_a'];
    this.P = Object.fromEntries(keys.map((k) => [k, this.params.index(k)]));
    const sigs = ['input.voltage', 'output.voltage', 'output.current', 'output.ripple', 'temp', 'brownout.count'];
    this.S = Object.fromEntries(sigs.map((k) => [k, this.sigIndex(k)]));
  }

  private pk(k: string): number {
    return this.p(this.P[k]!);
  }

  private outCurrent(): number {
    return this.outOn ? this.loadA * (1 + this.spike) + this.output.load + (this.forceOc ? 12 : 0) : 0;
  }

  override supplyCurrent(): number {
    if (this.mode === NodeMode.OFF) return 0;
    const vin = Math.max(5, this.supplyV);
    return 0.03 + (this.outV * this.outCurrent()) / (0.92 * vin);
  }

  distribute(): void {
    this.output.voltage = this.outOn ? this.outV : 0;
  }

  protected override onAppStart(): void {
    this.outOn = false;
  }

  protected override appTick(): void {
    const vin = this.supplyV;
    const target = this.pk('reg.output_v');
    const uvlo = this.pk('reg.uvlo_v');
    // Load spikes of the computer (CPU/GPU bursts).
    if (this.rng.next() < 0.002) this.spike = 0.3 + this.rng.next() * 0.6;
    this.spike *= 0.995;
    const wasOn = this.outOn;
    this.outOn = vin >= uvlo && !this.ocLatched;
    if (wasOn && !this.outOn && vin < uvlo) this.brownouts++;
    const iOut = this.outCurrent();
    const warn = this.pk('reg.current_warn_a');
    if (iOut > 2 * warn) {
      this.ocLatched = true;
      this.outOn = false;
    }
    // Available output power shrinks with input voltage (inductor current limit).
    const pMax = 70 * Math.min(1, vin / 12);
    const pNeed = target * iOut;
    this.outV = !this.outOn ? 0 : pNeed > pMax ? target * Math.sqrt(pMax / pNeed) : target - iOut * 0.01;
    const outOfReg = this.outOn && Math.abs(this.outV - target) > target * 0.05;
    const loss = this.outOn ? pNeed * 0.08 : 0;
    this.temp += (30 + loss * 3 - this.temp) * 0.0003;
    const s = this.sig;
    s[this.S['input.voltage']!] = vin + this.rng.gauss() * 0.01;
    s[this.S['output.voltage']!] = this.outV + (this.outOn ? this.rng.gauss() * 0.004 : 0);
    s[this.S['output.current']!] = iOut;
    s[this.S['output.ripple']!] = this.outOn ? 12 + 7 * iOut + Math.abs(this.rng.gauss()) * 3 + (outOfReg ? 80 : 0) : 0;
    s[this.S['temp']!] = this.temp;
    s[this.S['brownout.count']!] = this.brownouts;
    this.setFault(SOC_F.OUTPUT_OVERCURRENT, this.ocLatched);
    this.setFault(SOC_F.OUT_OF_REGULATION, outOfReg);
    this.setWarn(FaultBit.OVERCURRENT, iOut > warn);
    this.setWarn(FaultBit.UNDERVOLT, vin < uvlo + 0.5);
  }

  protected override onClearFaults(): void {
    this.ocLatched = false;
  }

  get brownoutCount(): number {
    return this.brownouts;
  }

  override supportedInjections(): InjectionKind[] {
    return ['outputOvercurrent'];
  }

  protected override injectModel(kind: InjectionKind, on: boolean): boolean {
    if (kind !== 'outputOvercurrent') return false;
    this.forceOc = on;
    return true;
  }

  protected override activeModelInjections(): InjectionKind[] {
    return this.forceOc ? ['outputOvercurrent'] : [];
  }
}
