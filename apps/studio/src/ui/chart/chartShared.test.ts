import { describe, expect, it } from 'vitest';
import { TICK_INCRS, tickDigits } from './chartShared';

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
