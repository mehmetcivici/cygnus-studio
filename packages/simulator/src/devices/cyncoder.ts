import { CommandStatus, MagnetStatus, Model } from '@cygnus/protocol';
import { NodeMode, SimNode, type InjectionKind, type SimNodeOptions } from '../node';
import type { Shaft } from '../world';

export type MagnetCondition = 'ok' | 'weak' | 'strong' | 'missing';

export interface CyncoderOptions extends SimNodeOptions {
  shaft?: Shaft | null;
  /** Sensor turns per shaft turn (mechanical coupling, not the `enc.ratio` setting). */
  ratio?: number;
  /** Mounting angle of the magnet, turns. */
  mountRot?: number;
}

const NOISE_LSB = [0.25, 0.4, 0.7, 1.1] as const; // by mag.slow_filter (16×, 8×, 4×, 2×)
const F = { MAGNET_MISSING: 10, MAGNET_WEAK: 11, MAGNET_STRONG: 12 } as const;

/** Cyncoder: 12-bit magnetic absolute encoder on a shaft, multi-turn tracking, magnet health. */
export class CyncoderNode extends SimNode {
  shaft: Shaft | null;
  ratio: number;
  magnet: MagnetCondition = 'ok';
  private readonly mountRot: number;
  private raw = 0;
  private lastRaw = -1;
  private turns = 0;
  private bootOffset = 0;
  private readonly hist = new Float64Array(128);
  private histHead = 0;
  private histN = 0;
  private temp = 30;
  private readonly P: Record<string, number>;
  private readonly S: Record<string, number>;

  constructor(o: CyncoderOptions = {}) {
    super(Model.CYNCODER, o);
    this.shaft = o.shaft ?? null;
    this.ratio = o.ratio ?? 1;
    this.mountRot = o.mountRot ?? 0;
    const keys = ['enc.zero_offset_rot', 'enc.invert', 'enc.abs_range', 'enc.ratio', 'enc.vel_window_ms', 'enc.boot_position',
      'mag.hysteresis', 'mag.slow_filter', 'mag.agc_strong', 'mag.agc_weak'];
    this.P = Object.fromEntries(keys.map((k) => [k, this.params.index(k)]));
    const sigs = ['abs.position', 'position', 'velocity', 'magnet.agc', 'magnet.status', 'raw.angle', 'temp'];
    this.S = Object.fromEntries(sigs.map((k) => [k, this.sigIndex(k)]));
  }

  private pk(k: string): number {
    return this.p(this.P[k]!);
  }

  /** True sensor angle in turns (continuous). */
  private sensorRot(): number {
    return this.shaft ? this.shaft.rot * this.ratio + this.mountRot : this.mountRot;
  }

  private readRaw(): number {
    if (this.magnet === 'missing') return this.rng.int(4096);
    const a = this.sensorRot();
    const frac = a - Math.floor(a);
    const noise = NOISE_LSB[this.pk('mag.slow_filter') as 0 | 1 | 2 | 3] ?? 0.7;
    const extra = this.magnet === 'weak' ? 2.5 : 1;
    let r = Math.round(frac * 4096 + this.rng.gauss() * noise * extra);
    r = ((r % 4096) + 4096) % 4096;
    const hyst = this.pk('mag.hysteresis');
    if (this.lastRaw >= 0 && hyst > 0) {
      let d = r - this.lastRaw;
      if (d > 2048) d -= 4096;
      if (d < -2048) d += 4096;
      if (Math.abs(d) <= hyst) r = this.lastRaw;
    }
    return r;
  }

  protected override onAppStart(): void {
    this.lastRaw = -1;
    this.turns = 0;
    this.histN = 0;
    this.raw = this.readRaw();
    this.lastRaw = this.raw;
    // "From zero" boots report 0 regardless of where the shaft sits.
    this.bootOffset = this.pk('enc.boot_position') === 1 ? this.raw / 4096 : 0;
  }

  /** Multi-turn position before invert / ratio / zero, turns. */
  private unwrapped(): number {
    return this.turns + this.raw / 4096;
  }

  protected override appTick(): void {
    const r = this.readRaw();
    let d = r - this.lastRaw;
    if (d > 2048) this.turns--;
    else if (d < -2048) this.turns++;
    this.lastRaw = r;
    this.raw = r;
    const dir = this.pk('enc.invert') ? -1 : 1;
    const zero = this.pk('enc.zero_offset_rot');
    const ratio = this.pk('enc.ratio') || 1;
    let abs = dir * (r / 4096 - zero);
    abs -= Math.floor(abs);
    if (this.pk('enc.abs_range') === 1 && abs >= 0.5) abs -= 1;
    const pos = (dir * (this.unwrapped() - zero - this.bootOffset)) / ratio;
    this.hist[this.histHead] = pos;
    this.histHead = (this.histHead + 1) & 127;
    if (this.histN < 128) this.histN++;
    const win = Math.max(1, Math.min(100, this.pk('enc.vel_window_ms')));
    let vel = 0;
    if (this.histN > win) {
      const old = this.hist[(this.histHead - 1 - win + 256) & 127]!;
      vel = ((pos - old) / win) * 60000;
    }
    const agc = this.agc();
    this.temp += (32 - this.temp) * 0.0001;
    const s = this.sig;
    s[this.S['abs.position']!] = abs;
    s[this.S['position']!] = pos;
    s[this.S['velocity']!] = vel;
    s[this.S['raw.angle']!] = r;
    s[this.S['magnet.agc']!] = agc;
    const st = this.status(agc);
    s[this.S['magnet.status']!] = st;
    s[this.S['temp']!] = this.temp;
    this.setFault(F.MAGNET_MISSING, st === MagnetStatus.MISSING);
    this.setWarn(F.MAGNET_WEAK, st === MagnetStatus.WEAK);
    this.setWarn(F.MAGNET_STRONG, st === MagnetStatus.STRONG);
  }

  /** AS5600-style AGC: high when the field is weak, low when it is strong. */
  private agc(): number {
    switch (this.magnet) {
      case 'missing':
        return 255;
      case 'weak':
        return 236 + this.rng.int(6);
      case 'strong':
        return 8 + this.rng.int(4);
    }
    return 126 + this.rng.int(5);
  }

  private status(agc: number): number {
    if (this.magnet === 'missing') return MagnetStatus.MISSING;
    if (agc >= this.pk('mag.agc_weak')) return MagnetStatus.WEAK;
    if (agc <= this.pk('mag.agc_strong')) return MagnetStatus.STRONG;
    return MagnetStatus.OK;
  }

  protected override action(cmd: number): { status: number; result: number } {
    if (cmd === 0x40) {
      if (this.magnet === 'missing') return { status: CommandStatus.FAILED, result: 0 };
      this.params.setKey('enc.zero_offset_rot', this.raw / 4096);
      this.turns = 0;
      this.bootOffset = 0;
      return { status: CommandStatus.OK, result: 0 };
    }
    if (cmd === 0x41) {
      this.turns = 0;
      this.bootOffset = 0;
      return { status: CommandStatus.OK, result: 0 };
    }
    return { status: CommandStatus.UNSUPPORTED, result: 0 };
  }

  protected override selfTest(): number {
    return this.magnet === 'missing' ? 1 << 1 : 0;
  }

  override supplyCurrent(): number {
    return this.mode === NodeMode.OFF ? 0 : 0.03;
  }

  override supportedInjections(): InjectionKind[] {
    return ['magnetMissing', 'magnetWeak', 'magnetStrong'];
  }

  protected override injectModel(kind: InjectionKind, on: boolean): boolean {
    const map: Partial<Record<InjectionKind, MagnetCondition>> = { magnetMissing: 'missing', magnetWeak: 'weak', magnetStrong: 'strong' };
    const c = map[kind];
    if (!c) return false;
    this.magnet = on ? c : 'ok';
    return true;
  }

  protected override activeModelInjections(): InjectionKind[] {
    return this.magnet === 'missing' ? ['magnetMissing'] : this.magnet === 'weak' ? ['magnetWeak'] : this.magnet === 'strong' ? ['magnetStrong'] : [];
  }
}
