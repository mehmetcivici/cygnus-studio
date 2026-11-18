import { getModel, Model } from '@cygnus/protocol';
import { describe, expect, it } from 'vitest';
import type { ProjectDevice } from '../../core';
import { copyCardToProject, diffCard, differing, replaceDevice, sameNumber } from './diff';
import { restoreToCard, type RestoreTarget } from './restore';

const def = getModel(Model.ESC_80A);
const dev = (params: Record<string, number>, o: Partial<ProjectDevice> = {}): ProjectDevice => ({
  uid48: 'a1', driver: 'cycan', model: Model.ESC_80A, modelKey: 'esc80a', devType: 2, num: 3, name: 'Sol', fw: '1.0.0', params, ...o,
});

describe('diffCard', () => {
  it('finds changed, equal and one-sided parameters in catalog order', () => {
    const rows = diffCard(dev({ 'vel.kp': 0.5, 'vel.ki': 0.1, 'only.project': 1 }), { num: 3, name: 'Sol', params: { 'vel.kp': 0.5, 'vel.ki': 0.2, 'only.card': 2 } }, def);
    const by = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(by['@num']?.same).toBe(true);
    expect(by['@name']?.same).toBe(true);
    expect(by['vel.kp']?.same).toBe(true);
    expect(by['vel.ki']).toMatchObject({ same: false, project: 0.1, card: 0.2 });
    expect(by['only.project']).toMatchObject({ same: false, card: undefined, writable: false });
    expect(by['only.card']).toMatchObject({ same: false, project: undefined, writable: false });
    const keys = rows.filter((r) => r.kind === 'param').map((r) => r.key);
    expect(keys.indexOf('vel.kp')).toBeLessThan(keys.indexOf('only.card'));
    expect(differing(rows).map((r) => r.id)).toEqual(expect.arrayContaining(['vel.ki', 'only.project', 'only.card']));
  });

  it('treats float32 round-off as equal and real changes as different', () => {
    expect(sameNumber(0.1, Math.fround(0.1))).toBe(true);
    expect(sameNumber(0.002, 0.0021)).toBe(false);
    expect(sameNumber(1500, 1500.0001)).toBe(true);
  });

  it('flags identity differences and never makes read-only parameters writable', () => {
    const ro = def?.params.find((p) => p.readOnly);
    expect(ro).toBeDefined();
    const rows = diffCard(dev({ [ro?.key ?? '']: 1 }, { num: 5, name: 'Yeni' }), { num: 3, name: 'Eski', params: { [ro?.key ?? '']: 2 } }, def);
    expect(rows.find((r) => r.id === '@num')).toMatchObject({ same: false, project: 5, card: 3, writable: true });
    expect(rows.find((r) => r.id === '@name')).toMatchObject({ same: false });
    expect(rows.find((r) => r.key === ro?.key)).toMatchObject({ same: false, writable: false });
  });
});

describe('project updates', () => {
  it('copies card values into the project for the chosen rows only', () => {
    const rows = diffCard(dev({ a: 1, b: 2 }), { num: 9, name: 'Kart', params: { a: 10, b: 20 } }, undefined);
    const out = copyCardToProject(dev({ a: 1, b: 2 }), rows.filter((r) => r.id === 'a' || r.id === '@num' || r.id === '@name'));
    expect(out.params).toEqual({ a: 10, b: 2 });
    expect(out.num).toBe(9);
    expect(out.name).toBe('Kart');
  });

  it('a replacement board takes over the project slot', () => {
    const out = replaceDevice([dev({}), dev({}, { uid48: 'zz' })], 'a1', { uid48: 'new', fw: '1.2.0' });
    expect(out.map((d) => d.uid48)).toEqual(['new', 'zz']);
    expect(out[0]).toMatchObject({ num: 3, fw: '1.2.0' });
  });
});

describe('restoreToCard', () => {
  function fake() {
    const calls: string[] = [];
    const t: RestoreTarget = {
      setParam: async (k, v) => {
        if (k === 'bad') throw new Error('rejected');
        calls.push(`set ${k}=${v}`);
        return v;
      },
      rename: async (n) => void calls.push(`rename ${n}`),
      save: async () => void calls.push('save'),
    };
    return { t, calls };
  }

  it('writes number, name, then parameters; skips unwritable rows; saves once', async () => {
    const { t, calls } = fake();
    const rows = diffCard(dev({ a: 1, b: 2, bad: 3 }, { num: 5, name: 'N' }), { num: 3, name: 'O', params: { a: 0, b: 0, bad: 0 } }, { ...(def as NonNullable<typeof def>), params: [{ ...(def?.params[0] as NonNullable<typeof def>['params'][number]), key: 'a' }, { ...(def?.params[0] as NonNullable<typeof def>['params'][number]), key: 'b' }, { ...(def?.params[0] as NonNullable<typeof def>['params'][number]), key: 'bad' }] });
    const r = await restoreToCard(t, rows, { save: true, assignNum: async (n) => void calls.push(`num ${n}`) });
    expect(calls).toEqual(['num 5', 'rename N', 'set a=1', 'set b=2', 'save']);
    expect(r).toMatchObject({ written: 4, failed: 1, saved: true });
    expect(r.results.find((x) => !x.ok)?.id).toBe('bad');
  });

  it('does not save when nothing was written', async () => {
    const { t, calls } = fake();
    const r = await restoreToCard(t, [], { save: true, assignNum: async () => undefined });
    expect(r.saved).toBe(false);
    expect(calls).toEqual([]);
  });
});
