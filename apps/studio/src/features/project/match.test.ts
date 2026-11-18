import { describe, expect, it } from 'vitest';
import type { ProjectDevice } from '../../core';
import { candidatesFor, matchCards, type LiveCard } from './match';

const pd = (uid48: string, model: number, num: number, name = ''): ProjectDevice => ({ uid48, driver: 'cycan', model, modelKey: `m${model}`, devType: 2, num, name, fw: '1.0.0', params: {} });
const lc = (uid48: string, model: number, num: number, o: Partial<LiveCard> = {}): LiveCard => ({ uid48, model, devType: 2, num, name: '', online: true, legacy: false, unresolved: false, ...o });

describe('matchCards', () => {
  it('pairs by uid48 regardless of number and case', () => {
    const r = matchCards([pd('aaaaaaaaaaaa', 2, 1)], [lc('AAAAAAAAAAAA', 2, 7)]);
    expect(r.pairs).toHaveLength(1);
    expect(r.pairs[0]?.by).toBe('uid');
    expect(r.missing).toHaveLength(0);
    expect(r.extra).toHaveLength(0);
  });

  it('reports missing and extra boards', () => {
    const r = matchCards([pd('a1', 2, 1), pd('a2', 3, 1)], [lc('a1', 2, 1), lc('b9', 8, 4)]);
    expect(r.pairs.map((p) => p.project.uid48)).toEqual(['a1']);
    expect(r.missing.map((m) => m.uid48)).toEqual(['a2']);
    expect(r.extra.map((e) => e.uid48)).toEqual(['b9']);
    expect(r.suggestions).toHaveLength(0);
  });

  it('suggests a replaced board by model + number', () => {
    const r = matchCards([pd('old1', 2, 3), pd('old2', 2, 4)], [lc('new1', 2, 4), lc('new2', 2, 3)]);
    expect(r.suggestions.map((s) => [s.project.uid48, s.live.uid48, s.reason])).toEqual([
      ['old1', 'new2', 'modelNum'],
      ['old2', 'new1', 'modelNum'],
    ]);
    expect(r.missing).toHaveLength(0);
    expect(r.extra).toHaveLength(0);
  });

  it('suggests the single candidate of a model even with another number (factory-fresh board)', () => {
    const r = matchCards([pd('old', 2, 3)], [lc('fresh', 2, 63, { unresolved: true })]);
    expect(r.suggestions[0]).toMatchObject({ reason: 'modelOnly' });
  });

  it('does not suggest across models or when ambiguous', () => {
    expect(matchCards([pd('old', 2, 3)], [lc('x', 3, 3)]).suggestions).toHaveLength(0);
    const r = matchCards([pd('old', 2, 3)], [lc('x', 2, 5), lc('y', 2, 6)]);
    expect(r.suggestions).toHaveLength(0);
    expect(r.missing).toHaveLength(1);
    expect(r.extra).toHaveLength(2);
  });

  it('honours a manual pairing of the same model only', () => {
    const live = [lc('x', 2, 9), lc('y', 3, 1)];
    const ok = matchCards([pd('old', 2, 3)], live, { old: 'x' });
    expect(ok.pairs[0]).toMatchObject({ by: 'manual' });
    const bad = matchCards([pd('old', 2, 3)], live, { old: 'y' });
    expect(bad.pairs).toHaveLength(0);
  });

  it('a uid match wins over a manual claim on the same live board', () => {
    const r = matchCards([pd('a', 2, 1), pd('b', 2, 2)], [lc('a', 2, 1)], { b: 'a' });
    expect(r.pairs).toHaveLength(1);
    expect(r.missing.map((m) => m.uid48)).toEqual(['b']);
  });

  it('lists hand-pairing candidates', () => {
    const r = matchCards([pd('old', 2, 3)], [lc('x', 2, 5), lc('y', 2, 6), lc('z', 3, 1)]);
    expect(candidatesFor(pd('old', 2, 3), r).map((c) => c.uid48).sort()).toEqual(['x', 'y']);
  });
});
