import { describe, expect, it } from 'vitest';

import { en } from '../src/i18n/en';
import { DEFAULT_LANG, createI18n, interpolate, isLang, parseLang, resolveLang } from '../src/i18n';
import { no, type MessageKey } from '../src/i18n/no';

describe('dictionaries', () => {
  it('have the same keys, no empty strings and the same placeholders', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(no).sort());
    for (const [key, value] of Object.entries({ ...no, ...en })) {
      expect(value.trim(), key).not.toBe('');
    }
    const placeholders = (text: string): string[] =>
      [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
    for (const key of Object.keys(no) as MessageKey[]) {
      expect(placeholders(en[key]), key).toEqual(placeholders(no[key]));
    }
  });
});

describe('interpolate', () => {
  it('substitutes placeholders, leaves unknown ones untouched and returns the template unchanged', () => {
    expect(interpolate('{a} of {b}', { a: 2, b: 5 })).toBe('2 of 5');
    // An unknown placeholder is never printed as undefined.
    expect(interpolate('{a} / {b}', { a: 1 })).toBe('1 / {b}');
    expect(interpolate('static')).toBe('static');
  });
});

describe('language resolution', () => {
  it('prefers ?lang over storage, falls back to storage then Norwegian, and rejects garbage', () => {
    expect(resolveLang('?lang=en', 'no')).toBe('en');
    expect(resolveLang('?lang=no', 'en')).toBe('no');
    expect(resolveLang('', 'en')).toBe('en');
    expect(resolveLang('', null)).toBe(DEFAULT_LANG);
    expect(DEFAULT_LANG).toBe('no');

    expect(parseLang('nb-NO')).toBe('no');
    expect(parseLang('nn')).toBe('no');
    expect(parseLang('en-GB')).toBe('en');
    expect(parseLang('de')).toBeNull();
    expect(isLang('no')).toBe(true);
    expect(isLang('fr')).toBe(false);
  });
});

describe('createI18n', () => {
  it('translates and switches language, notifies listeners once, and formats through the active language', () => {
    const i18n = createI18n('no');
    expect(i18n.t('stats.distance')).toBe('Distanse');
    const seen: string[] = [];
    i18n.onChange((lang) => seen.push(lang));
    i18n.setLang('en');
    expect(i18n.t('stats.distance')).toBe('Distance');
    expect(seen).toEqual(['en']);
    i18n.setLang('en');
    expect(seen).toEqual(['en']);

    expect(i18n.format.distance(4212)).toBe('4.21 km');
    expect(i18n.format.elevation(2468)).toBe('2,468 m a.s.l.');
    expect(i18n.format.duration(275)).toBe('4 h 35 min');
    expect(i18n.format.units.hour).toBe('h');

    const hint = i18n.t('stats.timeHint', { speed: '5', ascent: '600' });
    expect(hint).toContain('5 km/h');
    expect(hint).toContain('600 m');

    i18n.setLang('no');
    expect(i18n.format.distance(4212)).toBe('4,21 km');
    expect(i18n.format.elevation(2468)).toBe('2\u00a0468 moh');
  });
});
