import { describe, expect, it } from 'vitest';
import { CATALOG, CYNCODER_V3_DEF, getModel, Model, type ModelDef } from '@cygnus/protocol';
import { pickVisualization, tileSignals } from './viz';
import { buildParamFile, changedKeys, diffParams, needsReboot, parseParamFile, serializeParamFile } from './paramFile';
import { defaultCopySelection, planCopy } from './copyPlan';
import { controlRange, driveModes } from './control';
import { framePulses } from './servo';
import { OLED_COLS, textFrames } from './oledText';

function model(code: number): ModelDef {
  const d = getModel(code);
  if (!d) throw new Error(`no model ${code}`);
  return d;
}

function defaults(def: ModelDef): Record<string, number> {
  return Object.fromEntries(def.params.map((p) => [p.key, p.default]));
}

describe('visualisation registry', () => {
  it('picks one visualisation per catalog model (USB-CAN has none)', () => {
    const picked = Object.fromEntries(CATALOG.map((d) => [d.key, pickVisualization(d)]));
    expect(picked).toEqual({
      esc20a: 'esc',
      esc80a: 'esc',
      cyncoder: 'encoder',
      gyro: 'gyro',
      servo16: 'servo16',
      sealed_servo: 'sealedServo',
      pdh_small: 'pdhSmall',
      pdh_large: 'pdhLarge',
      soc_reg: 'soc',
      oled: 'oled',
      usbcan: null,
    });
    expect(pickVisualization(CYNCODER_V3_DEF)).toBe('legacyEncoder');
  });

  it('shows tiles only for unknown models', () => {
    expect(pickVisualization(undefined)).toBeNull();
    expect(tileSignals(undefined, null)).toEqual([]);
  });

  it('falls back by category for a future model with the same signals', () => {
    const esc = model(Model.ESC_80A);
    const future: ModelDef = { ...esc, key: 'esc200a', model: 99 };
    expect(pickVisualization(future)).toBe('esc');
    const bare: ModelDef = { ...esc, key: 'esc_bare', model: 98, signals: esc.signals.filter((s) => s.key !== 'duty') };
    expect(pickVisualization(bare)).toBeNull();
  });

  it('requires the signals the visualisation draws, even for a known key', () => {
    const gyro = model(Model.GYRO);
    expect(pickVisualization({ ...gyro, signals: gyro.signals.filter((s) => s.key !== 'roll') })).toBeNull();
  });

  it('leaves signals drawn by the visualisation out of the tile grid', () => {
    const pdh = model(Model.POWER_DIST_LARGE);
    const keys = tileSignals(pdh, 'pdhLarge').map((s) => s.key);
    expect(keys).toContain('input.voltage');
    expect(keys.some((k) => k.startsWith('ch.') || k.startsWith('aux') || k === 'fuse.mask')).toBe(false);
    const servo = model(Model.SERVO_16CH);
    expect(tileSignals(servo, 'servo16').map((s) => s.key)).toEqual(['rail.voltage', 'rail.current', 'temp']);
    // Without a visualisation every catalog signal is a tile.
    expect(tileSignals(servo, null)).toHaveLength(servo.signals.length);
  });
});

describe('settings file', () => {
  const esc = model(Model.ESC_80A);
  const src = { uid48: 'a867d8040149', num: 2, name: 'Volan', fw: '1.2.0' };

  it('round-trips through JSON and leaves read-only parameters out', () => {
    const values = { ...defaults(esc), 'vel.kp': 0.0035, 'motor.invert': 1 };
    const file = buildParamFile(esc, src, values, new Date('2026-11-18T10:00:00Z'));
    expect(file.params['can.termination']).toBeUndefined();
    const parsed = parseParamFile(serializeParamFile(file), esc);
    expect(parsed).toEqual({ ok: true, file });
    if (!parsed.ok) return;
    const rows = diffParams(esc, values, parsed.file.params);
    expect(changedKeys(rows)).toEqual([]);
    expect(rows.every((r) => r.status === 'same')).toBe(true);
  });

  it('counts f32 rounding as equal', () => {
    const rows = diffParams(esc, { 'vel.kp': Math.fround(0.0035) }, { 'vel.kp': 0.0035 });
    expect(rows[0]?.status).toBe('same');
  });

  it('diffs changed, invalid, read-only and unknown keys', () => {
    const current = defaults(esc);
    const rows = diffParams(esc, current, {
      'vel.kp': 0.01,
      'motor.pole_pairs': 7,
      'limits.temp_c': 9999,
      'can.termination': 1,
      'future.key': 3,
      'can.data_bitrate': 0,
    });
    const by = Object.fromEntries(rows.map((r) => [r.key, r.status]));
    expect(by).toEqual({
      'motor.pole_pairs': 'same',
      'limits.temp_c': 'invalid',
      'vel.kp': 'change',
      'can.data_bitrate': 'change',
      'can.termination': 'readOnly',
      'future.key': 'unknown',
    });
    expect(rows[rows.length - 1]?.key).toBe('future.key');
    expect(changedKeys(rows)).toEqual(['vel.kp', 'can.data_bitrate']);
    expect(needsReboot(rows, new Set(['vel.kp']))).toBe(false);
    expect(needsReboot(rows, new Set(['vel.kp', 'can.data_bitrate']))).toBe(true);
  });

  it('rejects broken, foreign and newer files', () => {
    expect(parseParamFile('{', esc)).toEqual({ ok: false, error: 'json' });
    expect(parseParamFile('{"format":"cygnus-project"}', esc)).toEqual({ ok: false, error: 'format' });
    const file = buildParamFile(esc, src, defaults(esc));
    expect(parseParamFile(JSON.stringify({ ...file, version: 9 }), esc)).toEqual({ ok: false, error: 'newerVersion' });
    expect(parseParamFile(JSON.stringify({ ...file, params: { 'vel.kp': 'x' } }), esc)).toEqual({ ok: false, error: 'shape' });
    expect(parseParamFile(serializeParamFile(file), model(Model.ESC_20A))).toEqual({ ok: false, error: 'wrongModel', fileModelKey: 'esc80a' });
  });
});

describe('copy plan', () => {
  const esc = model(Model.ESC_80A);
  const source = { ...defaults(esc), 'vel.kp': 0.004, 'vel.kv': 0.002, 'fb.remote_num': 4 };

  it('writes only differing selected keys and skips the source and per-board settings', () => {
    const sel = defaultCopySelection(esc, source);
    expect(sel.has('fb.remote_num')).toBe(false);
    expect(sel.has('can.termination')).toBe(false);
    const plan = planCopy(
      esc,
      'src',
      source,
      [
        { uid48: 'src', modelKey: 'esc80a', values: source },
        { uid48: 'b', modelKey: 'esc80a', values: { ...defaults(esc), 'vel.kp': 0.004 } },
        { uid48: 'c', modelKey: 'esc80a', values: defaults(esc) },
        { uid48: 'd', modelKey: 'esc20a', values: defaults(esc) },
      ],
      sel,
    );
    expect(plan.targets.map((t) => t.uid48)).toEqual(['b', 'c', 'd']);
    expect(plan.targets[0]?.writes).toEqual(['vel.kv']);
    expect(plan.targets[1]?.writes).toEqual(['vel.kp', 'vel.kv']);
    expect(plan.targets[2]?.wrongModel).toBe(true);
    expect(plan.total).toBe(3);
    expect(plan.keys).not.toContain('fb.remote_num');
  });

  it('copies a per-board key when the user selects it', () => {
    const sel = defaultCopySelection(esc, source);
    sel.add('fb.remote_num');
    const plan = planCopy(esc, 'src', source, [{ uid48: 'b', modelKey: 'esc80a', values: defaults(esc) }], sel);
    expect(plan.targets[0]?.writes).toContain('fb.remote_num');
  });

  it('plans nothing when the targets already match', () => {
    const plan = planCopy(esc, 'src', source, [{ uid48: 'b', modelKey: 'esc80a', values: source }], defaultCopySelection(esc, source));
    expect(plan.total).toBe(0);
  });
});

describe('manual drive helpers', () => {
  const esc = model(Model.ESC_80A);
  const frame = esc.controls.find((c) => c.format === 'set');

  it('offers every mode but "off" and narrows the slider to the measured signal', () => {
    if (!frame) throw new Error('no set frame');
    const modes = driveModes(frame);
    expect(modes.map((m) => m.key)).not.toContain('off');
    const pos = modes.find((m) => m.key === 'position');
    const vel = modes.find((m) => m.key === 'velocity');
    const brake = modes.find((m) => m.key === 'brake');
    if (!pos || !vel || !brake) throw new Error('modes');
    expect(controlRange(esc, pos)).toMatchObject({ min: -10, max: 10 });
    expect(controlRange(esc, vel)).toMatchObject({ min: -10000, max: 10000, step: 100, digits: 0 });
    expect(controlRange(esc, brake)).toBeNull();
    const duty = modes.find((m) => m.key === 'duty');
    if (!duty) throw new Error('duty');
    expect(controlRange(esc, duty)).toMatchObject({ min: -1, max: 1, step: 0.01, digits: 2 });
  });

  it('packs four servo pulses per frame, 0 for channels that are off', () => {
    const chs = Array.from({ length: 16 }, (_, i) => ({ on: i % 2 === 0, us: 1500 + i }));
    expect(framePulses(chs, 1)).toEqual([1500, 0, 1502, 0]);
    expect(framePulses(chs, 13)).toEqual([1512, 0, 1514, 0]);
  });

  it('splits OLED text into 6-character frames padded to the line end', () => {
    const f = textFrames(2, 'HELLO CYGNUS');
    expect(f.map((x) => x.col)).toEqual([0, 6, 12, 18]);
    expect(f.map((x) => x.text).join('')).toBe('HELLO CYGNUS'.padEnd(OLED_COLS, ' ').slice(0, 24));
    expect(f.every((x) => x.line === 2 && x.text.length <= 6)).toBe(true);
  });
});

// Regression (review tasarim B2): actions that spin the motor ran behind a confirm dialog only.
describe('movesActuator', () => {
  it('marks the catalog actions that drive the mechanism, and only those', async () => {
    const { CATALOG } = await import('@cygnus/protocol');
    const { movesActuator } = await import('./actions');
    const moving = CATALOG.flatMap((m) => m.actions.filter(movesActuator).map((a) => `${m.key}.${a.key}`));
    expect(moving).toEqual(expect.arrayContaining(['esc80a.detect_direction', 'esc80a.measure_motor', 'esc20a.detect_direction', 'servo16.center_all']));
    expect(moving.some((k) => /zero_here|set_yaw|calibrate_pwm|disable_all|reset_/.test(k))).toBe(false);
  });
});
