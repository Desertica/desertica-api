import { Injectable, UnprocessableEntityException } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { addDays, limaStartOfDay } from '../../common/time/lima';
import { PrismaService } from '../../prisma/prisma.service';
import { SEAT_HOLDING_STATUSES } from '../catalog/seats.service';

export type GroupBy = 'day' | 'tour' | 'provider';

const MAX_RANGE_DAYS = 366;
/** Un reclamo "vence pronto" si su plazo cae dentro de estos días. */
const COMPLAINT_SOON_DAYS = 3;
/** Pagos con dinero recibido (cuenta lo cobrado aunque luego se reembolse o dispute). */
const RECEIVED = Prisma.sql`('SUCCEEDED', 'PARTIALLY_REFUNDED', 'REFUNDED', 'DISPUTED')`;

export interface SalesRow {
  key: string;
  currency: 'USD' | 'PEN';
  grossCents: number;
  refundedCents: number;
  bookings: number;
}

/** Parte un rango de fechas de Lima (ambas incluidas) en `[desde, hasta)` UTC. */
export function limaRange(from: string, to: string) {
  const valid = (d: string) =>
    !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) &&
    new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;
  if (!valid(from) || !valid(to)) {
    throw new UnprocessableEntityException('from and to must be valid dates');
  }
  if (to < from) {
    throw new UnprocessableEntityException('to cannot be before from');
  }
  const days =
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) /
      86_400_000 +
    1;
  if (days > MAX_RANGE_DAYS) {
    throw new UnprocessableEntityException(
      `The range is limited to ${MAX_RANGE_DAYS} days`,
    );
  }
  return { start: limaStartOfDay(from), end: limaStartOfDay(addDays(to, 1)) };
}

/** Evita que una hoja de cálculo interprete la celda como fórmula. */
export function csvCell(value: string | number): string {
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(rows: SalesRow[]): string {
  const header = 'key,currency,grossCents,refundedCents,bookings';
  const lines = rows.map((r) =>
    [r.key, r.currency, r.grossCents, r.refundedCents, r.bookings]
      .map(csvCell)
      .join(','),
  );
  return `${[header, ...lines].join('\r\n')}\r\n`;
}

@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Cobrado, reembolsado y reservas por (clave, moneda); las claves salen de `groupBy`. */
  async sales(
    from: string,
    to: string,
    groupBy: GroupBy = 'day',
  ): Promise<SalesRow[]> {
    const { start, end } = limaRange(from, to);
    const paymentKey =
      groupBy === 'day'
        ? Prisma.sql`to_char((p."paidAt" AT TIME ZONE 'UTC') AT TIME ZONE 'America/Lima', 'YYYY-MM-DD')`
        : groupBy === 'tour'
          ? Prisma.sql`t."slug"`
          : Prisma.sql`p."provider"::text`;
    const refundKey =
      groupBy === 'day'
        ? Prisma.sql`to_char((r."updatedAt" AT TIME ZONE 'UTC') AT TIME ZONE 'America/Lima', 'YYYY-MM-DD')`
        : groupBy === 'tour'
          ? Prisma.sql`t."slug"`
          : Prisma.sql`p."provider"::text`;

    const [gross, refunded] = await Promise.all([
      this.prisma.$queryRaw<
        {
          key: string;
          currency: 'USD' | 'PEN';
          gross: bigint;
          bookings: bigint;
        }[]
      >`
        SELECT ${paymentKey} AS key, p."currency"::text AS currency,
               SUM(p."amountCents") AS gross,
               COUNT(DISTINCT p."bookingId") AS bookings
        FROM "Payment" p
        JOIN "Booking" b ON b."id" = p."bookingId"
        JOIN "Departure" d ON d."id" = b."departureId"
        JOIN "TourRef" t ON t."id" = d."tourRefId"
        WHERE p."status"::text IN ${RECEIVED}
          AND p."paidAt" >= ${start} AND p."paidAt" < ${end}
        GROUP BY 1, 2`,
      this.prisma.$queryRaw<
        { key: string; currency: 'USD' | 'PEN'; refunded: bigint }[]
      >`
        SELECT ${refundKey} AS key, p."currency"::text AS currency,
               SUM(r."amountCents") AS refunded
        FROM "Refund" r
        JOIN "Payment" p ON p."id" = r."paymentId"
        JOIN "Booking" b ON b."id" = p."bookingId"
        JOIN "Departure" d ON d."id" = b."departureId"
        JOIN "TourRef" t ON t."id" = d."tourRefId"
        WHERE r."status" = 'SUCCEEDED'
          AND r."updatedAt" >= ${start} AND r."updatedAt" < ${end}
        GROUP BY 1, 2`,
    ]);

    const rows = new Map<string, SalesRow>();
    const row = (key: string, currency: 'USD' | 'PEN') => {
      const id = `${key}|${currency}`;
      let existing = rows.get(id);
      if (!existing) {
        existing = {
          key,
          currency,
          grossCents: 0,
          refundedCents: 0,
          bookings: 0,
        };
        rows.set(id, existing);
      }
      return existing;
    };
    for (const g of gross) {
      const r = row(g.key, g.currency);
      r.grossCents = Number(g.gross);
      r.bookings = Number(g.bookings);
    }
    for (const f of refunded)
      row(f.key, f.currency).refundedCents = Number(f.refunded);
    return [...rows.values()].sort(
      (a, b) =>
        a.key.localeCompare(b.key) || a.currency.localeCompare(b.currency),
    );
  }

  async dashboard(from: string, to: string, now = new Date()) {
    const { start, end } = limaRange(from, to);
    const [sales, departures, pending] = await Promise.all([
      this.sales(from, to, 'day'),
      this.prisma.departure.findMany({
        where: {
          startsAt: { gte: start, lt: end },
          status: { not: 'CANCELLED' },
        },
        select: { id: true, capacity: true },
      }),
      this.pending(now),
    ]);

    const byCurrency = new Map<string, Omit<SalesRow, 'key'>>();
    for (const row of sales) {
      const acc = byCurrency.get(row.currency) ?? {
        currency: row.currency,
        grossCents: 0,
        refundedCents: 0,
        bookings: 0,
      };
      acc.grossCents += row.grossCents;
      acc.refundedCents += row.refundedCents;
      byCurrency.set(row.currency, acc);
    }
    // Las reservas distintas por moneda no se pueden sumar por día (una reserva paga en varios días).
    const distinct = await this.prisma.$queryRaw<
      { currency: 'USD' | 'PEN'; bookings: bigint }[]
    >`
      SELECT p."currency"::text AS currency, COUNT(DISTINCT p."bookingId") AS bookings
      FROM "Payment" p
      WHERE p."status"::text IN ${RECEIVED}
        AND p."paidAt" >= ${start} AND p."paidAt" < ${end}
      GROUP BY 1`;
    for (const d of distinct) {
      const acc = byCurrency.get(d.currency);
      if (acc) acc.bookings = Number(d.bookings);
    }

    const sold = departures.length
      ? await this.prisma.booking.aggregate({
          where: {
            departureId: { in: departures.map((d) => d.id) },
            status: { in: [...SEAT_HOLDING_STATUSES] },
          },
          _sum: { adults: true, children: true },
        })
      : null;
    return {
      sales: [...byCurrency.values()].sort((a, b) =>
        a.currency.localeCompare(b.currency),
      ),
      occupancy: {
        seatsSold: (sold?._sum.adults ?? 0) + (sold?._sum.children ?? 0),
        seatsCapacity: departures.reduce((n, d) => n + d.capacity, 0),
      },
      pending,
    };
  }

  private async pending(now: Date) {
    const soon = new Date(now.getTime() + COMPLAINT_SOON_DAYS * 86_400_000);
    const [
      unpaidBookings,
      documentsInError,
      waiversPending,
      openDisputes,
      complaintsDueSoon,
    ] = await Promise.all([
      this.prisma.booking.count({ where: { status: 'PENDING_PAYMENT' } }),
      this.prisma.document.count({
        where: { status: { in: ['ERROR', 'REJECTED'] } },
      }),
      this.prisma.waiver.count({
        where: {
          status: 'PENDING',
          booking: {
            status: { in: ['PENDING_PAYMENT', 'CONFIRMED'] },
            departure: { startsAt: { gt: now } },
          },
        },
      }),
      this.prisma.dispute.count({ where: { status: 'OPEN' } }),
      this.prisma.complaint.count({
        where: { status: { not: 'ANSWERED' }, dueAt: { lte: soon } },
      }),
    ]);
    return {
      unpaidBookings,
      documentsInError,
      waiversPending,
      openDisputes,
      complaintsDueSoon,
    };
  }
}
