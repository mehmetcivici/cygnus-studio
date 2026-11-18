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
