import { describe, expect, it } from 'vitest';
import { clamp, decimalsOf, formatEditable, parseNumber, stepNumber, validateNumber } from './numberField.logic';

describe('parseNumber', () => {
  it('accepts both decimal marks, signs and exponents', () => {
    expect(parseNumber('1,5')).toBe(1.5);
    expect(parseNumber('1.5')).toBe(1.5);
    expect(parseNumber(' -0,25 ')).toBe(-0.25);
    expect(parseNumber('−3')).toBe(-3);
    expect(parseNumber('+2')).toBe(2);
    expect(parseNumber(',5')).toBe(0.5);
    expect(parseNumber('2e-3')).toBe(0.002);
  });

  it('rejects ambiguous or non-numeric input', () => {
    expect(parseNumber('')).toBeNull();
    expect(parseNumber('abc')).toBeNull();
    expect(parseNumber('1.234,5')).toBeNull();
    expect(parseNumber('1,2,3')).toBeNull();
    expect(parseNumber('--1')).toBeNull();
    expect(parseNumber('1e999')).toBeNull();
  });
});

describe('validateNumber', () => {
  const c = { min: 0, max: 80, integer: false };
  it('reports the first violated constraint', () => {
    expect(validateNumber(40, c)).toBeNull();
    expect(validateNumber(null, c)).toEqual({ kind: 'invalid' });
    expect(validateNumber(-1, c)).toEqual({ kind: 'min', limit: 0 });
    expect(validateNumber(81, c)).toEqual({ kind: 'max', limit: 80 });
    expect(validateNumber(1.5, { integer: true })).toEqual({ kind: 'integer' });
    expect(validateNumber(0, c)).toBeNull();
    expect(validateNumber(80, c)).toBeNull();
  });
});

describe('stepNumber', () => {
  it('steps without floating point noise', () => {
    expect(stepNumber(0.1, 1, { step: 0.1 })).toBe(0.2);
    expect(stepNumber(0.2, 1, { step: 0.1 })).toBe(0.3);
    expect(stepNumber(0.0014, 1, { step: 0.0001 })).toBe(0.0015);
  });

  it('applies Shift (×10) and Alt (×0.1) multipliers', () => {
    expect(stepNumber(1, 1, { step: 0.1 }, 10)).toBe(2);
    expect(stepNumber(1, -1, { step: 0.1 }, 0.1)).toBe(0.99);
  });

  it('clamps to limits and keeps integers whole', () => {
    expect(stepNumber(79.5, 1, { step: 1, max: 80 })).toBe(80);
    expect(stepNumber(0, -1, { step: 1, min: 0 })).toBe(0);
    expect(stepNumber(5, 1, { step: 1, integer: true }, 0.1)).toBe(6);
  });
});

describe('helpers', () => {
  it('decimalsOf counts step precision', () => {
    expect(decimalsOf(1)).toBe(0);
    expect(decimalsOf(0.05)).toBe(2);
    expect(decimalsOf(0.0001)).toBe(4);
    expect(decimalsOf(1e-7)).toBe(7);
  });

  it('formatEditable uses the locale decimal mark without grouping', () => {
    expect(formatEditable(1234.5, 2, ',')).toBe('1234,50');
    expect(formatEditable(1234.5, 2, '.')).toBe('1234.50');
    expect(formatEditable(0.1 + 0.2, undefined, '.')).toBe('0.3');
    expect(formatEditable(null, 2, ',')).toBe('');
  });

  it('clamp', () => {
    expect(clamp(5, 0, 3)).toBe(3);
    expect(clamp(-5, 0)).toBe(0);
  });
});
