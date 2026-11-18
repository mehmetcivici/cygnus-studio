import {
  FIELD_SIZE,
  fieldRawRange,
  readU16,
  readU24,
  readU32,
  writeF32,
  writeU16,
  writeU24,
  writeU32,
  type ModelDef,
  type StatusFrameDef,
} from '@cygnus/protocol';

interface Field {
  sig: number;
  byte: number;
  size: number;
  f32: boolean;
  shift: number;
  mod: number;
  scale: number;
  bias: number;
  lo: number;
  hi: number;
}

/**
 * STATUS frame encoder compiled from the catalog layout. Produces the same bytes as the
 * catalog's `encodeStatusFrame` but reads signal values from a Float64Array and writes into a
 * caller buffer, so periodic status traffic allocates nothing.
 */
export class CompiledStatusFrame {
  readonly index: number;
  private readonly fields: Field[];

  constructor(def: ModelDef, frame: StatusFrameDef) {
    this.index = frame.index;
    this.fields = frame.fields.map((f) => {
      const sig = def.signals.findIndex((s) => s.key === f.signal);
      if (sig < 0) throw new Error(`${def.key}: status field references unknown signal ${f.signal}`);
      const [lo, hi] = fieldRawRange(f);
      return {
        sig,
        byte: f.byte,
        size: FIELD_SIZE[f.type],
        f32: f.type === 'f32',
        shift: f.bits !== undefined ? 2 ** (f.bit ?? 0) : 0,
        mod: f.bits !== undefined ? 2 ** f.bits : 0,
        scale: f.scale ?? 1,
        bias: f.bias ?? 0,
        lo,
        hi,
      };
    });
  }

  encode(sig: Float64Array, out: Uint8Array): void {
    for (let i = 0; i < 8; i++) out[i] = 0;
    for (let k = 0; k < this.fields.length; k++) {
      const f = this.fields[k]!;
      const v = sig[f.sig] ?? 0;
      if (f.f32) {
        writeF32(out, f.byte, v);
        continue;
      }
      let raw = Number.isFinite(v) ? Math.round((v - f.bias) / f.scale) : 0;
      if (raw < f.lo) raw = f.lo;
      else if (raw > f.hi) raw = f.hi;
      if (f.mod > 0) {
        const container = readContainer(f.size, out, f.byte);
        const cleared = container - (Math.floor(container / f.shift) % f.mod) * f.shift;
        writeContainer(f.size, out, f.byte, cleared + raw * f.shift);
      } else {
        writeContainer(f.size, out, f.byte, raw);
      }
    }
  }
}

function readContainer(size: number, d: Uint8Array, o: number): number {
  if (size === 1) return d[o] ?? 0;
  if (size === 2) return readU16(d, o);
  if (size === 3) return readU24(d, o);
  return readU32(d, o);
}

function writeContainer(size: number, d: Uint8Array, o: number, v: number): void {
  if (size === 1) d[o] = v & 0xff;
  else if (size === 2) writeU16(d, o, v);
  else if (size === 3) writeU24(d, o, v);
  else writeU32(d, o, v);
}
