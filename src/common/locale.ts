export const SUPPORTED_LOCALES = ['es', 'en'] as const;
export type AppLocale = (typeof SUPPORTED_LOCALES)[number];

/**
 * Idioma de una petición según `Accept-Language`: el primero de la lista (por
 * peso) que el sitio soporta; si ninguno, inglés.
 */
export function pickLocale(header: string | string[] | undefined): AppLocale {
  const raw = Array.isArray(header) ? header.join(',') : (header ?? '');
  const ranked = raw
    .split(',')
    .map((part, index) => {
      const [tag, ...params] = part.trim().split(';');
      const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
      const weight = q ? Number(q.slice(2)) : 1;
      return {
        lang: tag.trim().toLowerCase().split('-')[0],
        weight: Number.isFinite(weight) ? weight : 0,
        index,
      };
    })
    .filter((entry) => entry.weight > 0)
    .sort((a, b) => b.weight - a.weight || a.index - b.index);
  for (const { lang } of ranked) {
    if ((SUPPORTED_LOCALES as readonly string[]).includes(lang)) {
      return lang as AppLocale;
    }
  }
  return 'en';
}
