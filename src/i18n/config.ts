/**
 * i18n infrastructure.
 *
 * Translations are NOT implemented yet — this file defines the locale
 * contract so the rest of the app (layout, language switcher, routing)
 * can be wired up now and content populated later.
 */

export type Locale = 'en' | 'he' | 'ru';

export const DEFAULT_LOCALE: Locale = 'en';

export const LOCALES: readonly Locale[] = ['en', 'he', 'ru'] as const;

export interface LocaleMeta {
  code: Locale;
  /** Native-language label (shown in the switcher). */
  name: string;
  /** English label (used for aria-labels and fallbacks). */
  englishName: string;
  /** Writing direction. */
  dir: 'ltr' | 'rtl';
  /** BCP-47 tag for `<html lang>` and `hreflang`. */
  htmlLang: string;
}

export const LOCALE_META: Record<Locale, LocaleMeta> = {
  en: { code: 'en', name: 'English', englishName: 'English', dir: 'ltr', htmlLang: 'en' },
  he: { code: 'he', name: 'עברית', englishName: 'Hebrew', dir: 'rtl', htmlLang: 'he' },
  ru: { code: 'ru', name: 'Русский', englishName: 'Russian', dir: 'ltr', htmlLang: 'ru' },
};

/**
 * Resolve the active locale from a URL pathname. The default locale
 * (English) is served without a prefix; other locales use `/{code}/…`.
 */
export function localeFromPath(pathname: string): Locale {
  const seg = pathname.replace(/^\/+/, '').split('/')[0];
  return (LOCALES as readonly string[]).includes(seg) && seg !== DEFAULT_LOCALE
    ? (seg as Locale)
    : DEFAULT_LOCALE;
}

/**
 * Strip the locale prefix from a pathname, returning the canonical
 * path (always starting with `/`).
 */
export function stripLocale(pathname: string): string {
  const match = pathname.match(/^\/(en|he|ru)(\/|$)/);
  if (!match || match[1] === DEFAULT_LOCALE) return pathname || '/';
  const rest = pathname.slice(match[0].length - (match[2] === '/' ? 1 : 0));
  return rest.startsWith('/') ? rest : `/${rest}`;
}

/**
 * Build a localised URL for the given canonical path. Default locale
 * returns the path untouched.
 */
export function localisePath(path: string, locale: Locale): string {
  const canonical = stripLocale(path);
  if (locale === DEFAULT_LOCALE) return canonical;
  return `/${locale}${canonical === '/' ? '' : canonical}` || `/${locale}`;
}
