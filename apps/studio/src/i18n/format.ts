import { currentLang, type Lang } from './i18n';

export interface FmtOptions {
  lang?: Lang;
  /** Always show a sign (`+1,5`), useful for errors/deltas. */
  signed?: boolean;
  /** Thousands separators (default true). Off for IDs and raw values. */
  grouping?: boolean;
}

const LOCALES: Record<Lang, string> = { tr: 'tr-TR', en: 'en-US' };
const cache = new Map<string, Intl.NumberFormat>();

function formatter(lang: Lang, digits: number, grouping: boolean): Intl.NumberFormat {
  const id = `${lang}|${digits}|${grouping ? 1 : 0}`;
  let f = cache.get(id);
  if (!f) {
    f = new Intl.NumberFormat(LOCALES[lang], {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
      useGrouping: grouping,
    });
    cache.set(id, f);
  }
  return f;
}

/** Placeholder for missing / invalid values. */
export const NO_VALUE = '—';

/**
 * Formats a number with a fixed number of decimals in the UI language
 * (Turkish uses a decimal comma: `12,50`). null/NaN render as an em dash.
 */
export function fmtNumber(value: number | null | undefined, digits = 2, opts: FmtOptions = {}): string {
  if (value == null || Number.isNaN(value)) return NO_VALUE;
  if (!Number.isFinite(value)) return value > 0 ? '∞' : '−∞';
  const d = Math.max(0, Math.min(10, Math.trunc(digits)));
  // Avoid "-0,00" for tiny negatives that round to zero.
  const v = Math.abs(value) < 0.5 * 10 ** -d ? 0 : value;
  const s = formatter(opts.lang ?? currentLang(), d, opts.grouping ?? true).format(v);
  return opts.signed && v > 0 ? `+${s}` : s;
}

// Units written without a space before them.
const TIGHT_UNITS = new Set(['°', '%', '″', '′']);

/**
 * Number + unit using locale typography: `12,5 A`, `45°`; percent is
 * prefixed in Turkish (`%12,5`) and suffixed in English (`12.5%`).
 * A non-breaking space keeps value and unit together.
 */
export function fmtValue(value: number | null | undefined, unit?: string, digits = 2, opts: FmtOptions = {}): string {
  const num = fmtNumber(value, digits, opts);
  if (!unit || num === NO_VALUE) return num;
  const lang = opts.lang ?? currentLang();
  if (unit === '%') return lang === 'tr' ? `%${num}` : `${num}%`;
  return TIGHT_UNITS.has(unit) ? `${num}${unit}` : `${num} ${unit}`;
}

/** Hex for CAN IDs and raw bytes: `fmtHex(0x1a3, 3)` → `0x1A3`. */
export function fmtHex(value: number, width = 0, prefix = true): string {
  const s = (value >>> 0).toString(16).toUpperCase().padStart(width, '0');
  return prefix ? `0x${s}` : s;
}

/** Locale decimal separator. */
export function decimalSeparator(lang: Lang = currentLang()): ',' | '.' {
  return lang === 'tr' ? ',' : '.';
}
