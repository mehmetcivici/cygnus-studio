import { Model, getModel } from '@cygnus/protocol';
import { describe, expect, it } from 'vitest';
import { emptyProject, type ProjectDevice, type ProjectFile } from '../../core';
import { buildReport, catalogRows, formatParam } from './report';

const esc = getModel(Model.ESC_80A);
const def = (key: string) => {
  const p = esc?.params.find((x) => x.key === key);
  if (!p) throw new Error(key);
  return p;
};

function project(): ProjectFile {
  const p = emptyProject('Test robotu', '0.1.0', new Date('2026-11-01T10:00:00Z'));
  const ro = esc?.params.find((x) => x.readOnly);
  const devices: ProjectDevice[] = [
    {
      uid48: 'b2', driver: 'cycan', model: Model.ESC_80A, modelKey: 'esc80a', devType: 2, num: 4, name: 'Sağ',
      fw: '1.1.0', params: { 'vel.kp': def('vel.kp').default, 'vel.ki': def('vel.ki').default + 0.001, ...(ro ? { [ro.key]: 123 } : {}) },
    },
    { uid48: 'a1', driver: 'cycan', model: Model.ESC_80A, modelKey: 'esc80a', devType: 2, num: 3, name: 'Sol', fw: '1.1.0', params: { 'vel.kp': def('vel.kp').default + 0.5 } },
    { uid48: 'c3', driver: 'cyncoder-v3', model: 0, modelKey: 'cyncoder_v3', devType: 7, num: 1, name: '', fw: null, params: {} },
    { uid48: 'd4', driver: 'cycan', model: 200, modelKey: 'model200', devType: 10, num: 2, name: 'X', fw: null, params: { z: 1 } },
  ];
  p.bus = { capturedAt: '2026-11-01T10:05:00.000Z', devices };
  p.notes = 'Not';
  p.vehicle = { templateId: 'frc.tank', name: 'Tank', bindings: {} };
  return p;
}

describe('buildReport', () => {
  const r = buildReport(project(), 'tr', { appVersion: '0.1.0', now: new Date('2026-11-02T00:00:00Z') });

  it('orders boards by type and number and lists only non-default, writable parameters', () => {
    expect(r.cards.map((c) => [c.devType, c.num])).toEqual([[2, 3], [2, 4], [7, 1], [10, 2]]);
    const sol = r.cards.find((c) => c.uid48 === 'a1');
    const sag = r.cards.find((c) => c.uid48 === 'b2');
    expect(sol?.changed.map((c) => c.key)).toEqual(['vel.kp']);
    expect(sag?.changed.map((c) => c.key)).toEqual(['vel.ki']);
    expect(sag?.paramCount).toBe(Object.keys(project().bus.devices[0]?.params ?? {}).length);
    expect(r.changedTotal).toBe(2);
  });

  it('flags legacy and unknown-model boards without failing', () => {
    expect(r.cards.find((c) => c.uid48 === 'c3')).toMatchObject({ legacy: true, changed: [] });
    expect(r.cards.find((c) => c.uid48 === 'd4')).toMatchObject({ unknownModel: true, changed: [] });
  });

  it('is deterministic and language aware', () => {
    const en = buildReport(project(), 'en', { appVersion: '0.1.0', now: new Date('2026-11-02T00:00:00Z') });
    expect(en.cards[0]?.modelName).toBe(esc?.name.en);
    expect(r.cards[0]?.modelName).toBe(esc?.name.tr);
    expect(en.cards[0]?.changed[0]?.label).toBe(def('vel.kp').label.en);
    expect(r.generatedAt).toBe('2026-11-02T00:00:00.000Z');
    expect(r.protocol).toMatch(/^\d+\.\d+$/);
  });

  it('summarises the vehicle template and what is unbound', () => {
    expect(r.vehicle?.template).toBeTruthy();
    expect(r.vehicle?.unboundRequired).toBeGreaterThan(0);
    expect(buildReport({ ...project(), vehicle: null }, 'tr', { appVersion: '0' }).vehicle).toBeNull();
  });

  it('formats values by type', () => {
    const enumP = esc?.params.find((p) => p.options);
    if (enumP?.options?.[0]) expect(formatParam(enumP, enumP.options[0].value, 'en')).toBe(enumP.options[0].label.en);
    const boolP = esc?.params.find((p) => p.ptype === 3);
    if (boolP) expect(formatParam(boolP, 1, 'tr')).toBe('Açık');
  });
});

describe('catalogRows', () => {
  it('lists every model with its revision', () => {
    const rows = catalogRows('en');
    expect(rows.length).toBeGreaterThanOrEqual(11);
    expect(rows.every((x) => x.rev >= 1 && x.params > 0)).toBe(true);
  });
});
