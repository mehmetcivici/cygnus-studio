import { describe, expect, it } from 'vitest';
import { buildReport } from './report';
import { defaultSignal } from './signals';
import { detectSteps, stepMetrics } from './analysis/step';
import type { TunerRun } from './types';

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
});
