import { ParamStatus, checkParamValue, clampParamValue, quantizeParamValue, type ModelDef, type ParamDef } from '@cygnus/protocol';

export interface ParamReply {
  status: number;
  ptype: number;
  value: number;
}

/**
 * A board's parameter table: RAM values the firmware runs on, the persisted "flash" copy,
 * and the catalog defaults. Values are stored already quantized (f32 rounding etc.) so what
 * the host reads back is exactly what a real board would hold.
 */
export class ParamTable {
  readonly defs: readonly ParamDef[];
  readonly ram: Float64Array;
  readonly flash: Float64Array;
  private readonly byPid = new Map<number, number>();
  private readonly byKey = new Map<string, number>();
  /** Bumped on every RAM change, so devices can cache derived values cheaply. */
  version = 0;

  constructor(def: ModelDef, presets: Readonly<Record<string, number>> = {}) {
    this.defs = def.params;
    this.ram = new Float64Array(this.defs.length);
    this.flash = new Float64Array(this.defs.length);
    this.defs.forEach((p, i) => {
      this.byPid.set(p.pid, i);
      this.byKey.set(p.key, i);
      this.flash[i] = quantizeParamValue(p, p.default);
    });
    for (const [k, v] of Object.entries(presets)) {
      const i = this.byKey.get(k);
      if (i === undefined) throw new Error(`${def.key}: unknown preset parameter ${k}`);
      this.flash[i] = clampParamValue(this.defs[i]!, v);
    }
    this.ram.set(this.flash);
  }

  /** Index of a parameter key; throws so a catalog/simulator mismatch fails loudly at construction. */
  index(key: string): number {
    const i = this.byKey.get(key);
    if (i === undefined) throw new Error(`unknown parameter ${key}`);
    return i;
  }

  has(key: string): boolean {
    return this.byKey.has(key);
  }

  indexOfPid(pid: number): number {
    return this.byPid.get(pid) ?? -1;
  }

  get(i: number): number {
    return this.ram[i] ?? 0;
  }

  getKey(key: string): number {
    return this.get(this.index(key));
  }

  /** Firmware-side write (actions such as "zero here", "measure motor"); clamps into range. */
  set(i: number, value: number): void {
    const def = this.defs[i];
    if (!def) return;
    const v = clampParamValue(def, value);
    if (this.ram[i] !== v) {
      this.ram[i] = v;
      this.version++;
    }
  }

  setKey(key: string, value: number): void {
    this.set(this.index(key), value);
  }

  /** PARAM GET. */
  hostGet(pid: number): ParamReply {
    const i = this.indexOfPid(pid);
    if (i < 0) return { status: ParamStatus.UNKNOWN_PARAM, ptype: 0, value: 0 };
    const d = this.defs[i]!;
    return { status: ParamStatus.OK, ptype: d.ptype, value: this.ram[i] ?? 0 };
  }

  /** PARAM SET with every board-side check of PROTOCOL §5; a rejected SET returns the current value. */
  hostSet(pid: number, ptype: number, value: number, enabled: boolean): ParamReply {
    const i = this.indexOfPid(pid);
    if (i < 0) return { status: ParamStatus.UNKNOWN_PARAM, ptype, value: 0 };
    const d = this.defs[i]!;
    const cur = (): ParamReply => ({ status: ParamStatus.OK, ptype: d.ptype, value: this.ram[i] ?? 0 });
    if (ptype !== d.ptype) return { ...cur(), status: ParamStatus.TYPE_MISMATCH };
    if (d.readOnly) return { ...cur(), status: ParamStatus.READ_ONLY };
    if (d.lockedWhileEnabled && enabled) return { ...cur(), status: ParamStatus.DENIED_WHILE_ENABLED };
    if (checkParamValue(d, value) !== 'ok') return { ...cur(), status: ParamStatus.OUT_OF_RANGE };
    const v = quantizeParamValue(d, value);
    if (this.ram[i] !== v) {
      this.ram[i] = v;
      this.version++;
    }
    return cur();
  }

  get unsaved(): boolean {
    for (let i = 0; i < this.ram.length; i++) if (this.ram[i] !== this.flash[i]) return true;
    return false;
  }

  save(): void {
    this.flash.set(this.ram);
  }

  loadFlash(): void {
    this.ram.set(this.flash);
    this.version++;
  }

  loadDefaults(): void {
    this.defs.forEach((p, i) => (this.ram[i] = quantizeParamValue(p, p.default)));
    this.version++;
  }

  /** Factory reset of the persisted copy (corrupt flash recovery). */
  resetFlash(): void {
    this.defs.forEach((p, i) => (this.flash[i] = quantizeParamValue(p, p.default)));
  }

  /** Key → value map of RAM (snapshots, tests). */
  toRecord(): Record<string, number> {
    const out: Record<string, number> = {};
    this.defs.forEach((p, i) => (out[p.key] = this.ram[i] ?? 0));
    return out;
  }
}
