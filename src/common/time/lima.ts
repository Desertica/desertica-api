/**
 * Zona horaria de negocio: America/Lima. En base de datos todo va en UTC.
 * Perú no tiene horario de verano (UTC-5 todo el año), por eso los límites de
 * día y de mes se calculan con un desfase fijo; la fecha local de un instante
 * se obtiene con `Intl`, que sí respeta la zona.
 */
export const BUSINESS_TZ = 'America/Lima';
export const LIMA_UTC_OFFSET_HOURS = -5;

const dateFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: BUSINESS_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
const weekdayFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: BUSINESS_TZ,
  weekday: 'short',
});
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** `YYYY-MM-DD` de un instante en hora de Lima. */
export function limaDate(instant: Date): string {
  return dateFmt.format(instant);
}

/** 0 = domingo … 6 = sábado, según el calendario de Lima. */
export function limaWeekday(instant: Date): number {
  return WEEKDAYS.indexOf(weekdayFmt.format(instant));
}

/** Instante UTC de las 00:00 de Lima de un día `YYYY-MM-DD`. */
export function limaStartOfDay(date: string): Date {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, -LIMA_UTC_OFFSET_HOURS, 0, 0, 0));
}

/** `[desde, hasta)` en UTC de un mes `YYYY-MM` de Lima. */
export function limaMonthRange(month: string): { from: Date; to: Date } {
  const [y, m] = month.split('-').map(Number);
  const first = `${y}-${String(m).padStart(2, '0')}-01`;
  const next =
    m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
  return { from: limaStartOfDay(first), to: limaStartOfDay(next) };
}

/** Suma `days` a una fecha `YYYY-MM-DD` (calendario gregoriano, sin zona). */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Fecha `YYYY-MM-DD` de un `Date` de columna `@db.Date` (medianoche UTC). */
export function dbDateToString(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/** Valor para una columna `@db.Date` a partir de `YYYY-MM-DD`. */
export function stringToDbDate(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

/**
 * Suma `days` días hábiles (lunes a viernes, según el calendario de Lima) a un
 * instante, conservando la hora. No conoce feriados: ver `docs/PENDIENTES.md`.
 */
export function addBusinessDays(from: Date, days: number): Date {
  let current = new Date(from);
  let remaining = days;
  while (remaining > 0) {
    current = new Date(current.getTime() + 86_400_000);
    const weekday = limaWeekday(current);
    if (weekday !== 0 && weekday !== 6) remaining--;
  }
  return current;
}
