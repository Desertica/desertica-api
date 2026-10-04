import { Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

/** Estados de reserva que ocupan asientos. */
export const SEAT_HOLDING_STATUSES = [
  'PENDING_PAYMENT',
  'CONFIRMED',
  'COMPLETED',
  'NO_SHOW',
] as const;

export interface SeatCounts {
  sold: number;
  held: number;
}

type Db = PrismaService | Prisma.TransactionClient;

@Injectable()
export class SeatsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Asientos vendidos (reservas que ocupan cupo) y retenidos (bloqueos vigentes
   * que todavía no se convirtieron en reserva) por salida.
   */
  async countFor(
    departureIds: string[],
    now = new Date(),
    db: Db = this.prisma,
  ): Promise<Map<string, SeatCounts>> {
    const result = new Map<string, SeatCounts>(
      departureIds.map((id) => [id, { sold: 0, held: 0 }]),
    );
    if (departureIds.length === 0) return result;

    const [bookings, holds] = await Promise.all([
      db.booking.groupBy({
        by: ['departureId'],
        where: {
          departureId: { in: departureIds },
          status: { in: [...SEAT_HOLDING_STATUSES] },
        },
        _sum: { adults: true, children: true },
      }),
      db.hold.groupBy({
        by: ['departureId'],
        where: {
          departureId: { in: departureIds },
          releasedAt: null,
          expiresAt: { gt: now },
          booking: { is: null },
        },
        _sum: { seats: true },
      }),
    ]);
    for (const b of bookings) {
      result.get(b.departureId)!.sold =
        (b._sum.adults ?? 0) + (b._sum.children ?? 0);
    }
    for (const h of holds) result.get(h.departureId)!.held = h._sum.seats ?? 0;
    return result;
  }

  /** Bloquea la fila de la salida hasta el fin de la transacción. */
  async lockDeparture(
    tx: Prisma.TransactionClient,
    id: string,
  ): Promise<boolean> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "Departure" WHERE "id" = ${id} FOR UPDATE`;
    return rows.length === 1;
  }
}
