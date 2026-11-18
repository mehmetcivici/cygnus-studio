// Pure parsing/validation/stepping for NumberField, kept DOM-free for unit tests.

export interface NumberConstraints {
  min?: number;
  max?: number;
  /** Arrow/wheel increment (default 1). */
  step?: number;
  /** Reject fractional values. */
  integer?: boolean;
}

export type NumberError =
  | { kind: 'invalid' }
  | { kind: 'min'; limit: number }
  | { kind: 'max'; limit: number }
  | { kind: 'integer' };

const NUMBER_RE = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;

/**
 * Parses user input in either locale: `1,5` and `1.5` are both 1.5. A string
 * containing both separators is rejected rather than guessed (is `1.234,5`
 * a thousands separator or a typo?). Returns null for anything not a number.
 */
export function parseNumber(text: string): number | null {
  const s = text.replace(/[\s  ]/g, '').replace(/−/g, '-');
  if (!s) return null;
  if (s.includes(',') && s.includes('.')) return null;
  const norm = s.replace(',', '.');
  if (!NUMBER_RE.test(norm)) return null;
  const v = Number(norm);
  return Number.isFinite(v) ? v : null;
}

export function validateNumber(value: number | null, c: NumberConstraints): NumberError | null {
  if (value === null || !Number.isFinite(value)) return { kind: 'invalid' };
  if (c.integer && !Number.isInteger(value)) return { kind: 'integer' };
  if (c.min !== undefined && value < c.min) return { kind: 'min', limit: c.min };
  if (c.max !== undefined && value > c.max) return { kind: 'max', limit: c.max };
  return null;
}

/** Number of decimals needed to represent `step` exactly (0.001 → 3). */
export function decimalsOf(step: number): number {
  if (!Number.isFinite(step) || Number.isInteger(step)) return 0;
  const s = step.toString();
  const exp = /e-(\d+)$/.exec(s);
  if (exp?.[1]) return Number(exp[1]) + (s.split('e')[0]?.split('.')[1]?.length ?? 0);
  return s.split('.')[1]?.length ?? 0;
}

export function clamp(v: number, min = -Infinity, max = Infinity): number {
  return Math.min(max, Math.max(min, v));
}

/**
 * One arrow/wheel step. `multiplier` is 10 with Shift, 0.1 with Alt. The result
 * is rounded to the step's precision (no 0.30000000000000004) and clamped.
 */
export function stepNumber(value: number, direction: 1 | -1, c: NumberConstraints, multiplier = 1): number {
  const base = c.step ?? 1;
  let step = base * multiplier;
  if (c.integer) step = Math.max(1, Math.round(step));
  const decimals = c.integer ? 0 : decimalsOf(base) + (multiplier < 1 ? Math.round(-Math.log10(multiplier)) : 0);
  const next = Number((value + direction * step).toFixed(Math.min(12, decimals)));
  return clamp(next, c.min, c.max);
}

/** Text placed in the input while editing: no grouping, locale decimal mark. */
export function formatEditable(value: number | null, digits: number | undefined, decimalMark: ',' | '.'): string {
  if (value === null || !Number.isFinite(value)) return '';
  const s = digits === undefined ? String(Number(value.toPrecision(12))) : value.toFixed(digits);
  return decimalMark === ',' ? s.replace('.', ',') : s;
}
