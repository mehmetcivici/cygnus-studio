import { describe, expect, it } from 'vitest';
import { buildReport } from './report';
import { defaultSignal } from './signals';
import { detectSteps, stepMetrics } from './analysis/step';
import { EMPTY_SECTION, isTunerSection, type TunerRun } from './types';

function run(n: number, tau: number, note = ''): TunerRun {
  const t = Array.from({ length: 2000 }, (_, i) => i * 0.001);
  const target = t.map((x) => (x >= 0.2 ? 100 : 0));
  const measured = t.map((x) => (x >= 0.2 ? 100 * (1 - Math.exp(-(x - 0.2) / tau)) : 0));
  const m = stepMetrics(t, target, measured, detectSteps(t, target)[0]!);
  return {
    id: `r${n}`,
    n,
    createdAt: 0,
    uid48: 'u',
    deviceName: 'Volan',
    modelKey: 'esc80a',
    loopKey: 'velocity',
    unit: 'rpm',
    outputUnit: 'V',
    kind: 'closed',
    signal: defaultSignal('step', 100),
    gains: { kp: 0.002 * n, ki: 0 },
    gainSet: 'A',
    data: { t, target, measured, output: t.map(() => 1), error: t.map(() => 0), current: null },
    analysis: { steps: [m] },
    note,
    periodUs: 1000,
    lost: 0,
  };
}

describe('report', () => {
  it('builds a self-contained page with embedded SVG charts, in both languages', () => {
    const base = { title: 'Rapor', deviceName: 'Volan', modelName: 'ESC 80A', loopName: 'Hız', unit: 'rpm', roles: ['kp', 'ki'] as const, notes: 'a < b', projectName: '' };
    const runs = [run(1, 0.3), run(2, 0.05, '<b>not</b>')];
    const tr = buildReport({ ...base, lang: 'tr', runs });
    const en = buildReport({ ...base, lang: 'en', runs });
    expect(tr.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(tr).toContain('<svg');
    expect(tr).toContain('Özet ve karşılaştırma');
    expect(en).toContain('Summary and comparison');
    // Best run: the faster one.
    expect(tr).toContain('#2');
    expect(en).toMatch(/Best run: #2/);
    // User text is escaped.
    expect(tr).toContain('&lt;b&gt;not&lt;/b&gt;');
    expect(tr).toContain('a &lt; b');
    expect(tr).not.toContain('<script');
  });

  // Regression (review uygulama #5): a hostile project file put markup into `gainSet` and it
  // ran in a same-origin window. Every file-sourced value is escaped and the section is checked.
  it('escapes file-sourced values and forbids scripts', () => {
    const EVIL = '<img src=x onerror=alert(1)>';
    const bad = { ...run(1, 0.1, EVIL), gainSet: EVIL, unit: EVIL, outputUnit: EVIL, n: EVIL, deviceName: EVIL } as unknown as TunerRun;
    const html = buildReport({ title: EVIL, deviceName: EVIL, modelName: EVIL, loopName: EVIL, unit: EVIL, roles: ['kp'], notes: EVIL, projectName: EVIL, lang: 'tr', runs: [bad] });
    expect(html).not.toContain('<img');
    expect(html).not.toMatch(/<[^>]*onerror/i);
    expect(html).not.toContain('onclick');
    expect(html).toContain('http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;');
  });

  it('project section: rejects runs whose labels, units or gain sets are not plain', () => {
    const ok = { ...EMPTY_SECTION, runs: [run(1, 0.1)] };
    expect(isTunerSection(ok)).toBe(true);
    for (const patch of [{ gainSet: '<img src=x>' }, { gainSet: 'C' }, { unit: '<b>' }, { kind: 'evil' }, { n: '1' }, { gains: { kp: '1' } }, { gains: { evil: 1 } }]) {
      expect(isTunerSection({ ...ok, runs: [{ ...run(1, 0.1), ...patch }] })).toBe(false);
    }
    expect(isTunerSection({ ...ok, sets: { a: { A: { kp: 1 }, B: null, active: 'X' } } })).toBe(false);
    expect(isTunerSection({ ...ok, configs: { a: { signal: { kind: 'step' }, limits: {} } } })).toBe(false);
  });
});
