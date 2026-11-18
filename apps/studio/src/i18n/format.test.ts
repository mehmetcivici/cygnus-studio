import { describe, expect, it } from 'vitest';
import { fmtHex, fmtNumber, fmtValue } from './format';

describe('fmtNumber', () => {
  it('uses a decimal comma in Turkish and a point in English', () => {
    expect(fmtNumber(12.5, 2, { lang: 'tr' })).toBe('12,50');
    expect(fmtNumber(12.5, 2, { lang: 'en' })).toBe('12.50');
  });

  it('groups thousands per locale unless disabled', () => {
    expect(fmtNumber(1234567.891, 1, { lang: 'tr' })).toBe('1.234.567,9');
    expect(fmtNumber(1234567.891, 1, { lang: 'en' })).toBe('1,234,567.9');
    expect(fmtNumber(4812, 0, { lang: 'tr', grouping: false })).toBe('4812');
  });

  it('renders missing values as an em dash and avoids negative zero', () => {
    expect(fmtNumber(null)).toBe('—');
    expect(fmtNumber(undefined)).toBe('—');
    expect(fmtNumber(Number.NaN)).toBe('—');
    expect(fmtNumber(-0.0001, 2, { lang: 'tr' })).toBe('0,00');
    expect(fmtNumber(Infinity)).toBe('∞');
  });

  it('supports an explicit sign', () => {
    expect(fmtNumber(1.5, 1, { lang: 'tr', signed: true })).toBe('+1,5');
    expect(fmtNumber(-1.5, 1, { lang: 'en', signed: true })).toBe('-1.5');
  });
});

describe('fmtValue', () => {
  it('joins value and unit with a non-breaking space', () => {
    expect(fmtValue(12.5, 'A', 1, { lang: 'tr' })).toBe('12,5 A');
    expect(fmtValue(4812, 'rpm', 0, { lang: 'en' })).toBe('4,812 rpm');
  });

  it('writes degree signs tight and percent per locale', () => {
    expect(fmtValue(45, '°', 0, { lang: 'tr' })).toBe('45°');
    expect(fmtValue(37.5, '%', 1, { lang: 'tr' })).toBe('%37,5');
    expect(fmtValue(37.5, '%', 1, { lang: 'en' })).toBe('37.5%');
  });

  it('omits the unit for missing values', () => {
    expect(fmtValue(null, 'V')).toBe('—');
  });
});

describe('fmtHex', () => {
  it('formats CAN identifiers', () => {
    expect(fmtHex(0x1a3, 3)).toBe('0x1A3');
    expect(fmtHex(0x0a0403, 8, false)).toBe('000A0403');
  });
});
