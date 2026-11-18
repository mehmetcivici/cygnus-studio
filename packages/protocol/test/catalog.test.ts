import { describe, expect, it } from 'vitest';
import {
  CATALOG,
  Model,
  PType,
  checkParamValue,
  clampParamValue,
  decodeParamBytes,
  decodeStatusFrame,
  encodeParamBytes,
  encodeStatusFrame,
  fieldRawRange,
  getModel,
  paramById,
  paramByKey,
  signalByKey,
  signalBySid,
  statusFrameLength,
  toHex,
  validateCatalog,
  validateModel,
  type ModelDef,
} from '../src';

const esc20 = getModel(Model.ESC_20A)!;

describe('catalog contents', () => {
  it('has all 11 models with matching codes', () => {
    expect(CATALOG.map((m) => m.model)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    for (const m of CATALOG) expect(getModel(m.model)).toBe(m);
    expect(getModel(99)).toBeUndefined();
  });

  it('validates without issues', () => {
    expect(validateCatalog()).toEqual([]);
  });

  it.each(CATALOG.map((m) => [m.key, m] as const))('%s carries the common parameters', (_k, m) => {
    expect(paramById(m, 0x0001)?.key).toBe('can.data_bitrate');
    expect(paramById(m, 0x0002)?.key).toBe('can.termination');
    for (const f of m.statusFrames) expect(paramById(m, 0x0010 + f.index)?.key).toBe(`status.${f.index}.period_ms`);
    const actuator = m.controls.some((c) => c.format !== 'text');
    expect(paramById(m, 0x0003)?.key).toBe(actuator ? 'ctrl.timeout_ms' : undefined);
  });

  it('ESC templates share layout but differ in limits', () => {
    const esc80 = getModel(Model.ESC_80A)!;
    expect(esc20.params.length).toBeGreaterThanOrEqual(45);
    expect(esc20.params.length).toBeLessThanOrEqual(60);
    expect(esc80.params.map((p) => [p.pid, p.key])).toEqual(esc20.params.map((p) => [p.pid, p.key]));
    expect(paramByKey(esc80, 'limits.phase_current_a')!.max).toBeGreaterThan(paramByKey(esc20, 'limits.phase_current_a')!.max);
    expect(esc20.tuner.loops.map((l) => l.key)).toEqual(['current', 'velocity', 'position']);
  });

  it('Turkish labels use Turkish characters, not ASCII stand-ins', () => {
    const all = CATALOG.flatMap((m) => [...m.params.map((p) => p.label.tr), ...m.signals.map((s) => s.label.tr)]);
    expect(all.some((s) => /[çğışöüİ]/.test(s))).toBe(true);
    for (const s of all) expect(s).not.toMatch(/\b(Sinir|Hiz|Akim|Sicaklik|Gerilim dusuk)\b/);
  });

  it('accessors find params and signals both ways', () => {
    const p = paramByKey(esc20, 'vel.kp')!;
    expect(paramById(esc20, p.pid)).toBe(p);
    const s = signalByKey(esc20, 'velocity')!;
    expect(signalBySid(esc20, s.sid)).toBe(s);
    expect(paramByKey(esc20, 'nope')).toBeUndefined();
  });
});

describe('validator catches broken definitions', () => {
  const broken = (fn: (m: ModelDef) => void): string[] => {
    const m = structuredClone(esc20);
    fn(m);
    return validateModel(m).map((i) => `${i.path}: ${i.message}`);
  };

  it('duplicate pid / key / sid', () => {
    expect(broken((m) => (m.params[1]!.pid = m.params[0]!.pid)).join()).toMatch(/duplicate pid/);
    expect(broken((m) => (m.params[1]!.key = m.params[0]!.key)).join()).toMatch(/duplicate key/);
    expect(broken((m) => (m.signals[1]!.sid = m.signals[0]!.sid)).join()).toMatch(/duplicate sid/);
  });

  it('default outside range and bad enum default', () => {
    expect(broken((m) => (paramByKeyRaw(m, 'vel.kp').default = 5)).join()).toMatch(/default 5 invalid/);
    expect(broken((m) => (paramByKeyRaw(m, 'motor.idle_mode').default = 7)).join()).toMatch(/invalid_option/);
  });

  it('status frame overflow and overlap', () => {
    expect(broken((m) => (m.statusFrames[0]!.fields[2]!.byte = 7)).join()).toMatch(/exceeds 8 bytes/);
    expect(broken((m) => (m.statusFrames[0]!.fields[1]!.byte = 2)).join()).toMatch(/overlaps velocity/);
    expect(broken((m) => (m.statusFrames[0]!.fields[0]!.signal = 'ghost')).join()).toMatch(/unknown signal/);
  });

  it('tuner references and model fault range', () => {
    expect(broken((m) => (m.tuner.loops[1]!.gains.kV = 'vel.nope')).join()).toMatch(/unknown parameter 'vel.nope'/);
    expect(broken((m) => (m.tuner.loops[0]!.signals.measured = 'ghost')).join()).toMatch(/unknown signal 'ghost'/);
    expect(broken((m) => (m.tuner.loops[0]!.mode = 42)).join()).toMatch(/no mode 42/);
    expect(broken((m) => (m.faults[0]!.bit = 3)).join()).toMatch(/bit must be 10..15/);
  });

  it('missing translations', () => {
    expect(broken((m) => (m.params[0]!.help.en = ' ')).join()).toMatch(/help needs tr and en/);
  });
});

function paramByKeyRaw(m: ModelDef, key: string) {
  const p = m.params.find((x) => x.key === key);
  if (!p) throw new Error(key);
  return p;
}

describe('status frames', () => {
  it('ESC fast frame: f32 + scaled ints', () => {
    const f = esc20.statusFrames[0]!;
    const d = encodeStatusFrame(f, { velocity: 1500, 'phase.current': -12.34, duty: 0.5 });
    expect(toHex(d)).toBe('0080bb44' + '2efb' + '8813');
    const v = decodeStatusFrame(f, d)!;
    expect(v.velocity).toBe(1500);
    expect(v['phase.current']).toBeCloseTo(-12.34, 6);
    expect(v.duty).toBeCloseTo(0.5, 6);
  });

  it('saturates out-of-range values and encodes non-finite as 0', () => {
    const f = esc20.statusFrames[1]!;
    const d = encodeStatusFrame(f, { position: 1, 'bus.voltage': 1000, 'bus.current': Number.NaN });
    const v = decodeStatusFrame(f, d)!;
    expect(v['bus.voltage']).toBeCloseTo(655.35, 6);
    expect(v['bus.current']).toBe(0);
    expect(fieldRawRange({ signal: 'x', byte: 0, type: 'i16' })).toEqual([-32768, 32767]);
  });

  it('packs bit fields without disturbing neighbours (Cyncoder)', () => {
    const f = getModel(Model.CYNCODER)!.statusFrames[1]!;
    const d = encodeStatusFrame(f, { 'abs.position': 0.25, 'raw.angle': 4095, 'magnet.status': 3, 'magnet.agc': 200, temp: -10 });
    expect(toHex(d.subarray(4, 8))).toBe('ff3fc8f6');
    expect(decodeStatusFrame(f, d)).toEqual({ 'abs.position': 0.25, 'raw.angle': 4095, 'magnet.status': 3, 'magnet.agc': 200, temp: -10 });
    expect(decodeStatusFrame(f, d.subarray(0, 7))).toBeNull();
  });

  it.each(CATALOG.flatMap((m) => m.statusFrames.map((f) => [`${m.key}/${f.index}`, m, f] as const)))(
    '%s round-trips mid-range values',
    (_n, m, f) => {
      expect(statusFrameLength(f)).toBeLessThanOrEqual(8);
      const values: Record<string, number> = {};
      for (const fd of f.fields) {
        const s = signalByKey(m, fd.signal)!;
        const [lo, hi] = fieldRawRange(fd);
        const scale = fd.scale ?? 1;
        const want = (s.range[0] + s.range[1]) / 2;
        // Clip into what the field can carry, then onto its resolution.
        const raw = fd.type === 'f32' ? want : Math.min(hi, Math.max(lo, Math.round((want - (fd.bias ?? 0)) / scale)));
        values[fd.signal] = fd.type === 'f32' ? Math.fround(raw) : raw * scale + (fd.bias ?? 0);
      }
      const back = decodeStatusFrame(f, encodeStatusFrame(f, values))!;
      for (const [k, v] of Object.entries(values)) expect(back[k]).toBeCloseTo(v, 6);
    },
  );
});

describe('parameter values', () => {
  it('range, integer, enum and read-only checks', () => {
    const kp = paramByKey(esc20, 'vel.kp')!;
    expect(checkParamValue(kp, 0.5)).toBe('ok');
    expect(checkParamValue(kp, -0.1)).toBe('out_of_range');
    expect(checkParamValue(kp, Number.NaN)).toBe('not_number');
    const pp = paramByKey(esc20, 'motor.pole_pairs')!;
    expect(checkParamValue(pp, 7.5)).toBe('not_integer');
    const idle = paramByKey(esc20, 'motor.idle_mode')!;
    expect(checkParamValue(idle, 1)).toBe('ok');
    expect(checkParamValue(idle, 2)).toBe('invalid_option');
    const term = paramByKey(esc20, 'can.termination')!;
    expect(checkParamValue(term, 0)).toBe('read_only');
    expect(checkParamValue(term, 0, { allowReadOnly: true })).toBe('ok');
    const period = paramByKey(esc20, 'status.0.period_ms')!;
    expect(checkParamValue(period, 0)).toBe('ok');
    expect(checkParamValue(period, 3)).toBe('below_min_nonzero');
    expect(clampParamValue(period, 3)).toBe(5);
    expect(clampParamValue(kp, 9)).toBe(Math.fround(1));
  });

  it('f32 bounds tolerate single-precision rounding', () => {
    const tol = paramByKey(esc20, 'pos.tolerance_rot')!;
    expect(checkParamValue(tol, Math.fround(10))).toBe('ok');
  });

  it('encodes by ptype into 4 little-endian bytes', () => {
    expect(toHex(encodeParamBytes(paramByKey(esc20, 'vel.kp')!, 0.25))).toBe('0000803e');
    expect(toHex(encodeParamBytes(paramByKey(esc20, 'ctrl.timeout_ms')!, 250))).toBe('fa000000');
    expect(toHex(encodeParamBytes(paramByKey(esc20, 'motor.invert')!, 1))).toBe('01000000');
    const i32 = { ...paramByKey(esc20, 'vel.kp')!, ptype: PType.I32 };
    expect(toHex(encodeParamBytes(i32, -2))).toBe('feffffff');
    expect(decodeParamBytes(i32, Uint8Array.of(0xfe, 0xff, 0xff, 0xff))).toBe(-2);
    expect(decodeParamBytes(paramByKey(esc20, 'vel.kp')!, Uint8Array.of(0, 0, 0x80, 0x3e))).toBe(0.25);
  });
});
