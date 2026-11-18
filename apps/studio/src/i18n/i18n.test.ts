import { beforeEach, describe, expect, it } from 'vitest';
import { registerMessages, setLang, t, tl, hasMessage, currentLang } from './i18n';
import './messages';

describe('i18n', () => {
  beforeEach(() => setLang('tr'));

  it('defaults to Turkish and translates core keys', () => {
    expect(currentLang()).toBe('tr');
    expect(t('nav.bus')).toBe('Hat');
    setLang('en');
    expect(t('nav.bus')).toBe('Bus');
  });

  it('registers namespaced dictionaries with typed scoped translators', () => {
    const tx = registerMessages('test', {
      tr: { a: { b: 'Merhaba {name}' }, n: '{count} kart' },
      en: { a: { b: 'Hello {name}' }, n: '{count} device | {count} devices' },
    });
    expect(tx('a.b', { name: 'Cygnus' })).toBe('Merhaba Cygnus');
    expect(t('test.a.b', { name: 'X' })).toBe('Merhaba X');
    expect(tx.key('a.b')).toBe('test.a.b');
    expect(tx.ns).toBe('test');
    setLang('en');
    expect(tx('a.b', { name: 'Cygnus' })).toBe('Hello Cygnus');
    expect(tx('n', { count: 1 })).toBe('1 device');
    expect(tx('n', { count: 3 })).toBe('3 devices');
    expect(tx('n')).toBe('{count} devices');
  });

  it('re-registering replaces the namespace (HMR)', () => {
    registerMessages('hmr', { tr: { x: 'bir', y: 'iki' }, en: { x: 'one', y: 'two' } });
    registerMessages('hmr', { tr: { x: 'BİR' }, en: { x: 'ONE' } });
    expect(t('hmr.x')).toBe('BİR');
    expect(hasMessage('hmr.y')).toBe(false);
  });

  it('falls back to Turkish, then to the key itself', () => {
    registerMessages('fb', { tr: { only: 'yalnız TR' }, en: { only: '' } });
    setLang('en');
    expect(t('fb.missing')).toBe('fb.missing');
    expect(t('fb.only')).toBe('yalnız TR');
  });

  it('keeps unknown placeholders intact', () => {
    registerMessages('ph', { tr: { m: '{a} ve {b}' }, en: { m: '{a} and {b}' } });
    expect(t('ph.m', { a: 1 })).toBe('1 ve {b}');
  });

  it('tl resolves LocalizedText with Turkish fallback', () => {
    expect(tl({ tr: 'Hız', en: 'Velocity' })).toBe('Hız');
    setLang('en');
    expect(tl({ tr: 'Hız', en: 'Velocity' })).toBe('Velocity');
    expect(tl({ tr: 'Hız', en: '' })).toBe('Hız');
    expect(tl('plain')).toBe('plain');
    expect(tl(null)).toBe('');
  });
});
