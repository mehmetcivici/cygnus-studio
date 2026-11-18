import { create } from 'zustand';
import { readStored, writeStored } from '../lib/storage';

export type Lang = 'tr' | 'en';
export const LANGS: readonly Lang[] = ['tr', 'en'];

/** Two-language text, as used by device catalogs. */
export interface LocalizedText {
  tr: string;
  en: string;
}

/** Nested message tree; leaves are message strings. */
export type Messages = { readonly [key: string]: string | Messages };

/** Dotted key paths of a message tree: `{ a: { b: '' } }` → `'a.b'`. */
export type MessageKeys<T> = {
  [K in keyof T & string]: T[K] extends string ? K : T[K] extends Messages ? `${K}.${MessageKeys<T[K]>}` : never;
}[keyof T & string];

/** Same tree shape with plain string leaves; forces EN to mirror TR exactly. */
export type MessageShape<T> = { readonly [K in keyof T]: T[K] extends string ? string : MessageShape<T[K]> };

export type MessageParams = Readonly<Record<string, string | number>>;

/** A translator scoped to one namespace with type-checked keys. */
export interface Translator<K extends string> {
  (key: K, params?: MessageParams): string;
  readonly ns: string;
  /** Fully qualified key (`ns.key`) for APIs that take global keys, e.g. `labelKey`. */
  key: (key: K) => string;
}

const STORAGE_KEY = 'cy.lang';

const dictionaries: Record<Lang, Map<string, string>> = { tr: new Map(), en: new Map() };
const warned = new Set<string>();

function flatten(prefix: string, tree: Messages, out: Map<string, string>): void {
  for (const [k, v] of Object.entries(tree)) {
    const full = `${prefix}.${k}`;
    if (typeof v === 'string') out.set(full, v);
    else flatten(full, v, out);
  }
}

/**
 * Registers a feature's dictionary under a namespace and returns a typed
 * translator for it. Call at module top level in the feature's own directory:
 *
 * ```ts
 * export const tt = registerMessages('tuner', { tr: { run: 'Koş' }, en: { run: 'Run' } });
 * tt('run'); // also reachable globally as t('tuner.run')
 * ```
 * Re-registering a namespace replaces it (keeps HMR working).
 */
export function registerMessages<const T extends Messages>(
  ns: string,
  messages: { tr: T; en: MessageShape<T> },
): Translator<MessageKeys<T>> {
  for (const lang of LANGS) {
    const dict = dictionaries[lang];
    for (const key of [...dict.keys()]) if (key.startsWith(`${ns}.`)) dict.delete(key);
    flatten(ns, messages[lang] as Messages, dict);
  }
  const scoped = ((key: string, params?: MessageParams) => t(`${ns}.${key}`, params)) as unknown as Translator<MessageKeys<T>>;
  Object.defineProperty(scoped, 'ns', { value: ns });
  scoped.key = (key) => `${ns}.${key}`;
  return scoped;
}

interface LangState {
  lang: Lang;
  setLang: (lang: Lang) => void;
}

function initialLang(): Lang {
  return readStored(STORAGE_KEY) === 'en' ? 'en' : 'tr';
}

/** Current language store. Prefer `useI18n()` in components. */
export const useLangStore = create<LangState>((set) => ({
  lang: initialLang(),
  setLang: (lang) => {
    writeStored(STORAGE_KEY, lang);
    if (typeof document !== 'undefined') document.documentElement.lang = lang;
    set({ lang });
  },
}));

export function currentLang(): Lang {
  return useLangStore.getState().lang;
}

export function setLang(lang: Lang): void {
  useLangStore.getState().setLang(lang);
}

function interpolate(msg: string, params: MessageParams | undefined): string {
  let text = msg;
  // "one | other" plural form, picked by the numeric `count` param (format the
  // displayed number into another placeholder if it needs grouping).
  if (text.includes(' | ')) {
    const [one = '', other = one] = text.split(' | ');
    text = params?.count === 1 ? one : other;
  }
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const v = params[name];
    return v === undefined ? whole : String(v);
  });
}

/**
 * Translates a fully qualified key in the current language. Falls back to
 * Turkish, then to the key itself (so a missing entry is visible, not blank).
 * Components must call `useI18n()` so they re-render on language change.
 */
export function t(key: string, params?: MessageParams, lang: Lang = currentLang()): string {
  const msg = dictionaries[lang].get(key) || dictionaries.tr.get(key);
  if (msg === undefined) {
    if (!warned.has(key) && import.meta.env?.DEV) {
      warned.add(key);
      console.warn(`[i18n] missing message: ${key}`);
    }
    return key;
  }
  return interpolate(msg, params);
}

/** True when the key exists in the Turkish (reference) dictionary. */
export function hasMessage(key: string): boolean {
  return dictionaries.tr.has(key);
}

/** Resolves catalog-style `{tr, en}` text (or passes plain strings through). */
export function tl(text: LocalizedText | string | null | undefined, lang: Lang = currentLang()): string {
  if (text == null) return '';
  if (typeof text === 'string') return text;
  return text[lang] || text.tr;
}
