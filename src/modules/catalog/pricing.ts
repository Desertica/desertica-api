import { limaDate } from '../../common/time/lima';

export interface RuleLike {
  id: string;
  unit: 'PER_PERSON' | 'PER_GROUP';
  adultCents: number;
  childCents: number | null;
  groupCents: number | null;
  minPeople: number | null;
  maxPeople: number | null;
  validFrom: Date | null;
  validTo: Date | null;
  priority: number;
  createdAt: Date;
}

const asDay = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Regla que aplica a una salida: vigente en la fecha local de Lima, con el
 * tamaño del grupo dentro de `[minPeople, maxPeople]` (si se conoce) y la de
 * mayor `priority`; a igual prioridad, la más reciente. Se asume que las
 * reglas ya vienen filtradas por tour, moneda, formato y `active`.
 */
export function selectRule<T extends RuleLike>(
  rules: T[],
  departureStartsAt: Date,
  people?: number,
): T | null {
  const day = limaDate(departureStartsAt);
  const candidates = rules.filter((r) => {
    if (r.validFrom && day < asDay(r.validFrom)) return false;
    if (r.validTo && day > asDay(r.validTo)) return false;
    if (people !== undefined) {
      if (r.minPeople !== null && people < r.minPeople) return false;
      if (r.maxPeople !== null && people > r.maxPeople) return false;
    }
    return true;
  });
  candidates.sort(
    (a, b) =>
      b.priority - a.priority || b.createdAt.getTime() - a.createdAt.getTime(),
  );
  return candidates[0] ?? null;
}

export interface BlackoutLike {
  tourRefId: string | null;
  startsOn: Date;
  endsOn: Date;
}

/** ¿La fecha local de la salida cae en una fecha bloqueada (global o del tour)? */
export function isBlackedOut(
  blackouts: BlackoutLike[],
  tourRefId: string,
  startsAt: Date,
): boolean {
  const day = limaDate(startsAt);
  return blackouts.some(
    (b) =>
      (b.tourRefId === null || b.tourRefId === tourRefId) &&
      day >= asDay(b.startsOn) &&
      day <= asDay(b.endsOn),
  );
}

/** Venta abierta: salida OPEN y todavía antes del corte de venta. */
export function isOnSale(
  departure: { status: string; startsAt: Date; cutoffMinutes: number },
  now: Date,
): boolean {
  return (
    departure.status === 'OPEN' &&
    departure.startsAt.getTime() - departure.cutoffMinutes * 60_000 >
      now.getTime()
  );
}
