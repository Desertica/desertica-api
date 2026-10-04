import type { Lang } from './layout';

/** Idioma del correo: español para `es*`, inglés para todo lo demás. */
export function langOf(locale: string | undefined | null): Lang {
  return locale?.toLowerCase().startsWith('es') ? 'es' : 'en';
}

const INTL: Record<Lang, string> = { es: 'es-PE', en: 'en-US' };

/** Lee un campo de texto de los datos de la plantilla, o `fallback` si falta. */
export function str(data: Record<string, unknown>, key: string, fallback = '') {
  const value = data[key];
  return typeof value === 'string' || typeof value === 'number'
    ? String(value)
    : fallback;
}

export function num(data: Record<string, unknown>, key: string): number | null {
  const value = data[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function strList(data: Record<string, unknown>, key: string): string[] {
  const value = data[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

/** Importe en la unidad menor (`*Cents`) con su moneda, p. ej. `US$ 100.00`. */
export function formatMoney(
  cents: number,
  currency: string,
  lang: Lang,
): string {
  try {
    return new Intl.NumberFormat(INTL[lang], {
      style: 'currency',
      currency,
    }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}

/** Fecha y hora en la zona de negocio (America/Lima). */
export function formatDateTime(iso: string, lang: Lang): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const text = new Intl.DateTimeFormat(INTL[lang], {
    dateStyle: 'full',
    timeStyle: 'short',
    timeZone: 'America/Lima',
  }).format(date);
  return lang === 'es' ? `${text} (hora de Lima)` : `${text} (Lima time)`;
}

export function formatDate(iso: string, lang: Lang): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(INTL[lang], {
    dateStyle: 'long',
    timeZone: 'America/Lima',
  }).format(date);
}
