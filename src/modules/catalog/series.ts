import { addDays, limaDate, limaWeekday } from '../../common/time/lima';

export const MAX_SERIES = 400;

/**
 * Instantes de una serie: la misma hora local de Lima que `first`, desde su
 * fecha hasta `until` (inclusive), solo en los días de la semana indicados
 * (0 = domingo). Como Lima no tiene horario de verano, sumar días de 24 h
 * conserva la hora local.
 */
export function expandSeries(
  first: Date,
  until: string,
  weekdays: number[],
): Date[] {
  const startDay = limaDate(first);
  if (until < startDay) return [];
  const wanted = new Set(weekdays);
  const result: Date[] = [];
  for (let day = startDay, n = 0; day <= until; day = addDays(day, 1), n++) {
    const instant = new Date(first.getTime() + n * 86_400_000);
    if (wanted.has(limaWeekday(instant))) result.push(instant);
    if (result.length > MAX_SERIES) break;
  }
  return result;
}
