/**
 * Typed, dependency-free i18n.
 *
 * `no.ts` is the source of truth for keys; `en.ts` must implement the same
 * record, so a missing string is a type error rather than an English word in a
 * Norwegian UI. Language selection order:
 *
 *   1. `?lang=en` in the URL (explicit, wins over everything)
 *   2. localStorage (the user's last choice)
 *   3. Norwegian (the default for Norwegian data)
 */

import { en } from './en';
import { no, type MessageKey } from './no';
import type { Lang } from '../lib/format';
import {
  formatDistance,
  formatDistanceAxis,
  formatDuration,
  formatElevation,
  formatElevationRange,
  formatGrade,
  formatNumber,
  localeFor,
  unitsFor,
} from '../lib/format';

export type { MessageKey };
export type { Lang };

const DICTIONARIES: Record<Lang, Record<MessageKey, string>> = { no, en };
const STORAGE_KEY = 'ruteanalyse.lang';
export const DEFAULT_LANG: Lang = 'no';

export function isLang(value: unknown): value is Lang {
  return value === 'no' || value === 'en';
}

/** Parse a language code from a string; returns null when it is not supported. */
export function parseLang(value: string | null | undefined): Lang | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase().slice(0, 2);
  if (normalized === 'no' || normalized === 'nb' || normalized === 'nn') return 'no';
  if (normalized === 'en') return 'en';
  return null;
}

/** Resolve the initial language: URL override, then storage, then Norwegian. */
export function resolveLang(search: string, stored: string | null): Lang {
  const params = new URLSearchParams(search);
  return parseLang(params.get('lang')) ?? parseLang(stored) ?? DEFAULT_LANG;
}

export function readStoredLang(storage: Pick<Storage, 'getItem'> | null): string | null {
  if (!storage) return null;
  try {
    return storage.getItem(STORAGE_KEY);
  } catch {
    // Storage can throw in private mode / sandboxed iframes. Language choice is
    // not worth breaking the app over; fall through to the default.
    return null;
  }
}

export function storeLang(storage: Pick<Storage, 'setItem'> | null, lang: Lang): void {
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, lang);
  } catch {
    // Ignore: persistence is a convenience, not a requirement.
  }
}

export type Params = Record<string, string | number>;

/** Substitute `{name}` placeholders. Unknown placeholders are left untouched. */
export function interpolate(template: string, params?: Params): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, key: string) => {
    const value = params[key];
    return value === undefined ? match : String(value);
  });
}

export interface I18n {
  readonly lang: Lang;
  readonly locale: string;
  t(key: MessageKey, params?: Params): string;
  setLang(lang: Lang): void;
  /** Re-apply static `data-i18n*` attributes inside `root`. */
  apply(root: ParentNode): void;
  onChange(listener: (lang: Lang) => void): () => void;
  format: {
    number(value: number, options?: Intl.NumberFormatOptions): string;
    distance(metres: number): string;
    distanceAxis(metres: number): string;
    elevation(metres: number, aboveSea?: boolean): string;
    elevationRange(min: number, max: number): string;
    duration(minutes: number): string;
    grade(percent: number): string;
    readonly units: ReturnType<typeof unitsFor>;
  };
}

export function createI18n(initial: Lang): I18n {
  let lang: Lang = initial;
  const listeners = new Set<(lang: Lang) => void>();

  const api: I18n = {
    get lang() {
      return lang;
    },
    get locale() {
      return localeFor(lang);
    },
    t(key, params) {
      const dictionary = DICTIONARIES[lang];
      const template = dictionary[key];
      // Keys are typed, so this only triggers if a dictionary is corrupted at
      // runtime. Returning the key beats throwing in the middle of a render.
      return template === undefined ? key : interpolate(template, params);
    },
    setLang(next) {
      if (!isLang(next) || next === lang) return;
      lang = next;
      for (const listener of listeners) listener(lang);
    },
    apply(root) {
      for (const element of root.querySelectorAll<HTMLElement>('[data-i18n]')) {
        const key = element.dataset.i18n as MessageKey | undefined;
        if (key) element.textContent = api.t(key);
      }
      for (const element of root.querySelectorAll<HTMLElement>('[data-i18n-aria-label]')) {
        const key = element.dataset.i18nAriaLabel as MessageKey | undefined;
        if (key) element.setAttribute('aria-label', api.t(key));
      }
      for (const element of root.querySelectorAll<HTMLElement>('[data-i18n-title]')) {
        const key = element.dataset.i18nTitle as MessageKey | undefined;
        if (key) element.setAttribute('title', api.t(key));
      }
      for (const element of root.querySelectorAll<HTMLElement>('[data-i18n-placeholder]')) {
        const key = element.dataset.i18nPlaceholder as MessageKey | undefined;
        if (key) element.setAttribute('placeholder', api.t(key));
      }
      for (const element of root.querySelectorAll<HTMLElement>('[data-i18n-content]')) {
        const key = element.dataset.i18nContent as MessageKey | undefined;
        if (key) element.setAttribute('content', api.t(key));
      }
      const title = root.querySelector('title');
      if (title) title.textContent = api.t('app.name');
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    format: {
      number: (value, options) => formatNumber(value, lang, options),
      distance: (metres) => formatDistance(metres, lang),
      distanceAxis: (metres) => formatDistanceAxis(metres, lang),
      elevation: (metres, aboveSea = true) => formatElevation(metres, lang, aboveSea),
      elevationRange: (min, max) => formatElevationRange(min, max, lang),
      duration: (minutes) => formatDuration(minutes, lang),
      grade: (percent) => formatGrade(percent, lang),
      get units() {
        return unitsFor(lang);
      },
    },
  };

  return api;
}
