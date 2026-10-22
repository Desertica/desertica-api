export const SUPPORTED_LOCALES = ['en', 'es'] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'en';

/** Web URL with the language prefix (`/es/booking/ABC`); the home page keeps its trailing slash (`/en/`). */
export function webUrl(
  baseUrl: string,
  locale: string | null | undefined,
  path = '',
): string {
  const lang = SUPPORTED_LOCALES.find((l) => l === locale) ?? DEFAULT_LOCALE;
  return `${baseUrl.replace(/\/+$/, '')}/${lang}/${path.replace(/^\/+/, '')}`;
}
