import en from './en.json';
import he from './he.json';
import ru from './ru.json';
import { DEFAULT_LOCALE, type Locale } from './config';

type Dict = Record<string, unknown>;

const DICTIONARIES: Record<Locale, Dict> = {
  en: en as Dict,
  he: he as Dict,
  ru: ru as Dict,
};

function resolve(dict: Dict, key: string): string | undefined {
  const value = key.split('.').reduce<unknown>((acc, part) => {
    if (acc && typeof acc === 'object') return (acc as Dict)[part];
    return undefined;
  }, dict);
  return typeof value === 'string' ? value : undefined;
}

/**
 * Look up a translation key for the given locale. Falls back to the
 * default locale when the key is missing, then to the key itself so
 * missing translations are obvious but non-fatal.
 */
export function t(locale: Locale, key: string): string {
  return (
    resolve(DICTIONARIES[locale], key) ??
    resolve(DICTIONARIES[DEFAULT_LOCALE], key) ??
    key
  );
}

/** Factory for a bound `t` helper in an Astro page / component. */
export function createT(locale: Locale) {
  return (key: string) => t(locale, key);
}
