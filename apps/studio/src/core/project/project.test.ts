import { describe, expect, it } from 'vitest';
import { PROJECT_FORMAT, emptyProject, parseProject, serializeProject, type ProjectFile } from './schema';
import { defineProjectSection } from './sections';
import { loadProjectText, useProject } from './store';

function sample(): ProjectFile {
  const p = emptyProject('Swerve 2026', '0.1.0', new Date('2026-01-02T03:04:05Z'));
  p.bus = {
    capturedAt: '2026-01-02T03:05:00.000Z',
    devices: [
      { uid48: 'a867d8040149', driver: 'cycan', model: 2, modelKey: 'esc80a', devType: 2, num: 3, name: 'Sol ön', fw: '1.2.0', params: { 'vel.kp': 0.002, 'motor.inverted': 1 } },
    ],
  };
  p.vehicle = { templateId: 'frc.swerve4', name: 'Robot', bindings: { 'fl.drive': { kind: 'device', uid48: 'a867d8040149', model: 'esc80a' } } };
  p.notes = 'Not: "tırnak" ve satır\nsonu';
  p.sections = { 'tuner.runs': [{ id: 1, kp: 0.1 }], 'future.feature': { x: [1, 2] } };
  return p;
}

describe('project file', () => {
  it('round-trips through text unchanged', () => {
    const p = sample();
    const text = serializeProject(p);
    const r = parseProject(text);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.project).toEqual(p);
      expect(serializeProject(r.project)).toBe(text);
    }
  });

  it('rejects foreign, broken and newer files', () => {
    expect(parseProject('{nope')).toMatchObject({ ok: false, error: 'json' });
    expect(parseProject({ format: 'other' })).toMatchObject({ ok: false, error: 'format' });
    expect(parseProject({ format: PROJECT_FORMAT, version: 99 })).toMatchObject({ ok: false, error: 'newerVersion' });
    expect(parseProject({ format: PROJECT_FORMAT, version: 1, bus: { devices: [{ nope: 1 }] } })).toMatchObject({ ok: false, error: 'shape' });
  });

  it('fills defaults for missing optional parts and drops non-numeric params', () => {
    const r = parseProject({ format: PROJECT_FORMAT, version: 1, bus: { devices: [{ uid48: 'ABCDEF000001', model: 3, params: { a: 1, b: 'x' } }] } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.project.vehicle).toBeNull();
    expect(r.project.sections).toEqual({});
    expect(r.project.bus.devices[0]?.uid48).toBe('abcdef000001');
    expect(r.project.bus.devices[0]?.params).toEqual({ a: 1 });
  });
});

describe('project sections', () => {
  const isNums = (v: unknown): v is number[] => Array.isArray(v) && v.every((x) => typeof x === 'number');
  const runs = defineProjectSection('test.runs', { initial: [] as number[], guard: isNums });

  it('stores typed data and falls back to the initial value on bad data', () => {
    expect(runs.get()).toEqual([]);
    runs.set((r) => [...r, 1]);
    runs.set((r) => [...r, 2]);
    expect(runs.get()).toEqual([1, 2]);
    expect(useProject.getState().dirty).toBe(true);
    const text = serializeProject({ ...useProject.getState().project, sections: { 'test.runs': 'garbage' } });
    expect(loadProjectText(text).ok).toBe(true);
    expect(runs.get()).toEqual([]);
    expect(useProject.getState().project.sections['test.runs']).toBe('garbage');
    runs.clear();
    expect('test.runs' in useProject.getState().project.sections).toBe(false);
  });
});

describe('project file hardening (uygulama #8, #16)', () => {
  const base = { format: PROJECT_FORMAT };
  it('accepts only integer versions ≥ 1', () => {
    for (const version of [0.5, -1e308, 0, '1']) expect(parseProject({ ...base, version })).toMatchObject({ ok: false, error: 'shape' });
  });

  it('rejects malformed uid48', () => {
    expect(parseProject({ ...base, version: 1, bus: { devices: [{ uid48: 'A', model: 3 }] } })).toMatchObject({ ok: false, error: 'shape' });
  });

  it('drops damaged vehicle bindings with a warning instead of crashing the screen later', () => {
    const r = parseProject({
      ...base,
      version: 1,
      vehicle: {
        templateId: 'frc.swerve4',
        name: 'R',
        bindings: {
          'fl.drive': null,
          'fr.drive': 'x',
          'bl.drive': { uid48: 123 },
          'br.drive': { kind: 'device', uid48: 'A867D8040149', model: 'esc80a' },
          'gyro': { kind: 'channel', uid48: 'a867d8040149', model: 'servo16', channel: 1.5 },
          'ext': { kind: 'external', note: 'roboRIO PWM 0' },
        },
      },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.project.vehicle?.bindings).toEqual({
      'br.drive': { kind: 'device', uid48: 'a867d8040149', model: 'esc80a' },
      ext: { kind: 'external', note: 'roboRIO PWM 0' },
    });
    expect(r.warnings.map((w) => w.path).sort()).toEqual(['vehicle.bindings.bl.drive', 'vehicle.bindings.fl.drive', 'vehicle.bindings.fr.drive', 'vehicle.bindings.gyro']);
  });
});

describe('project section validate / migrate', () => {
  interface V2 {
    items: string[];
  }
  const isV2 = (v: unknown): v is V2 => typeof v === 'object' && v !== null && Array.isArray((v as V2).items);
  const sec = defineProjectSection<V2>('test.v2', {
    initial: { items: [] },
    validate: isV2,
    version: 2,
    migrate: (raw, from) => (from === 1 && Array.isArray(raw) ? { items: raw.map(String) } : undefined),
  });

  it('migrates version-1 data, writes the version, and survives throwing validators', () => {
    loadProjectText(serializeProject({ ...emptyProject('', '0'), sections: { 'test.v2': ['a', 'b'] } }));
    expect(sec.get()).toEqual({ items: ['a', 'b'] });
    sec.set((v) => ({ items: [...v.items, 'c'] }));
    expect(useProject.getState().project.sectionVersions?.['test.v2']).toBe(2);
    // round trip keeps the version, so no second migration happens
    const again = parseProject(serializeProject(useProject.getState().project));
    expect(again.ok && again.project.sectionVersions?.['test.v2']).toBe(2);

    const boom = defineProjectSection<number>('test.boom', {
      initial: 7,
      validate: (v): v is number => {
        if (v === 'x') throw new Error('bad');
        return typeof v === 'number';
      },
    });
    loadProjectText(serializeProject({ ...emptyProject('', '0'), sections: { 'test.boom': 'x' } }));
    expect(boom.get()).toBe(7);
  });

  it('reads newer-version data as the initial value', () => {
    loadProjectText(serializeProject({ ...emptyProject('', '0'), sections: { 'test.v2': { items: ['z'] } }, sectionVersions: { 'test.v2': 9 } }));
    expect(sec.get()).toEqual({ items: [] });
  });

  it('requires migrate when version > 1', () => {
    expect(() => defineProjectSection('test.nomig', { initial: 0, validate: (v): v is number => typeof v === 'number', version: 2 })).toThrow(/migrate/);
  });
});
