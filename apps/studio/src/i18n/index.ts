import { useCallback } from 'react';
import { setLang, t, tl, useLangStore, type Lang, type LocalizedText, type MessageParams } from './i18n';
import { fmtNumber, fmtValue, type FmtOptions } from './format';
import './messages';

export {
  registerMessages,
  t,
  tl,
  setLang,
  currentLang,
  hasMessage,
  useLangStore,
  LANGS,
} from './i18n';
export type { Lang, LocalizedText, Messages, MessageKeys, MessageShape, MessageParams, Translator } from './i18n';
export { fmtNumber, fmtValue, fmtHex, decimalSeparator, NO_VALUE } from './format';
export type { FmtOptions } from './format';
export { tCommon, tNav, tStatus, tUi, tApp } from './messages';

export interface I18n {
  lang: Lang;
  setLang: (lang: Lang) => void;
  t: (key: string, params?: MessageParams) => string;
  tl: (text: LocalizedText | string | null | undefined) => string;
  fmtNumber: (value: number | null | undefined, digits?: number, opts?: Omit<FmtOptions, 'lang'>) => string;
  fmtValue: (value: number | null | undefined, unit?: string, digits?: number, opts?: Omit<FmtOptions, 'lang'>) => string;
}

/**
 * Subscribes the component to language changes and returns language-bound
 * helpers. Typed per-feature translators (from `registerMessages`) also work
 * inside any component that calls this hook.
 */
export function useI18n(): I18n {
  const lang = useLangStore((s) => s.lang);
  return {
    lang,
    setLang,
    t: useCallback((key: string, params?: MessageParams) => t(key, params, lang), [lang]),
    tl: useCallback((text: LocalizedText | string | null | undefined) => tl(text, lang), [lang]),
    fmtNumber: useCallback((v: number | null | undefined, d?: number, o?: Omit<FmtOptions, 'lang'>) => fmtNumber(v, d, { ...o, lang }), [lang]),
    fmtValue: useCallback(
      (v: number | null | undefined, u?: string, d?: number, o?: Omit<FmtOptions, 'lang'>) => fmtValue(v, u, d, { ...o, lang }),
      [lang],
    ),
  };
}

