import { describe, expect, it } from 'vitest';
import { TICK_INCRS, logTickLabels, tickDigits } from './chartShared';

describe('chart ticks (tasarim B18)', () => {
  it('uses 1-2-5 steps only', () => {
    for (const s of TICK_INCRS) expect([1, 2, 5]).toContain(Number((s / 10 ** Math.floor(Math.log10(s) + 1e-9)).toPrecision(1)));
    expect(TICK_INCRS).not.toContain(0.025);
  });
  it('prints as many decimals as the step needs', () => {
    expect(tickDigits(0.025)).toBe(3);
    expect(tickDigits(0.05)).toBe(2);
    expect(tickDigits(0.5)).toBe(1);
    expect(tickDigits(20)).toBe(0);
    expect(tickDigits(0.0002)).toBe(4);
  });
});

describe('log axis tick labels (ISTEKLER: StaticChart xScale=log)', () => {
  const splits = [0.5, 0.6, 0.7, 0.8, 0.9, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 20, 30, 50, 100, 200];
  it('labels only 1·2·5 × 10ⁿ, with the unit, never NaN or a stray unit', () => {
    const l = logTickLabels(splits, ' Hz', 'tr', 300);
    expect(l.filter(Boolean)).toEqual(['0,5 Hz', '1 Hz', '2 Hz', '5 Hz', '10 Hz', '20 Hz', '50 Hz', '100 Hz', '200 Hz']);
    for (const x of l) expect(x).not.toMatch(/NaN|^ ?Hz$|^–/);
  });
  it('keeps only decades when they are packed', () => {
    expect(logTickLabels(splits, '', 'en', 60).filter(Boolean)).toEqual(['1', '10', '100']);
  });
  it('small values get enough digits', () => {
    expect(logTickLabels([0.01, 0.02, 0.05], ' s', 'en', 300)).toEqual(['0.01 s', '0.02 s', '0.05 s']);
  });
});
