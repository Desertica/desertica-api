import { Injectable, NotFoundException } from '@nestjs/common';
import { pendingCents } from '../../common/money';
import { PrismaService } from '../../prisma/prisma.service';
import { toDepartureDto } from './catalog.mappers';
import { SEAT_HOLDING_STATUSES, SeatsService } from './seats.service';

@Injectable()
export class ManifestService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly seats: SeatsService,
  ) {}

  /**
   * Pasajeros de la salida. Una fila por pasajero registrado; si la reserva no
   * registró pasajeros, una fila con el titular. El saldo por cobrar va solo
   * en la primera fila de cada reserva para no contarlo dos veces.
   */
  async forDeparture(id: string) {
    const departure = await this.prisma.departure.findUnique({ where: { id } });
    if (!departure) throw new NotFoundException('Departure not found');
    const counts = await this.seats.countFor([id]);

    const bookings = await this.prisma.booking.findMany({
      where: { departureId: id, status: { in: [...SEAT_HOLDING_STATUSES] } },
      orderBy: { createdAt: 'asc' },
      include: { customer: true, passengers: true, waivers: true },
    });

    const passengers = bookings.flatMap((b) => {
      const balance = pendingCents(b.totalCents, b.paidCents, b.refundedCents);
      const signed = (passengerId: string | null) =>
        b.waivers.find(
          (w) =>
            w.status === 'SIGNED' &&
            (w.passengerId === passengerId || w.passengerId === null),
        );
      const rows =
        b.passengers.length > 0
          ? b.passengers.map((p) => ({
              name: `${p.firstName} ${p.lastName}`,
              idDocType: p.idDocType ?? undefined,
              idDocNumber: p.idDocNumber,
              emergencyContactName: p.emergencyContactName,
              emergencyContactPhone: p.emergencyContactPhone,
              waiver: signed(p.id),
            }))
          : [
              {
                name: `${b.customer.firstName} ${b.customer.lastName}`,
                idDocType: b.customer.idDocType ?? undefined,
                idDocNumber: b.customer.idDocNumber,
                emergencyContactName: null,
                emergencyContactPhone: null,
                waiver: signed(null),
              },
            ];
      return rows.map((row, index) => ({
        bookingReference: b.reference,
        name: row.name,
        idDocType: row.idDocType,
        idDocNumber: row.idDocNumber,
        phone: b.customer.phone,
        emergencyContactName: row.emergencyContactName,
        emergencyContactPhone: row.emergencyContactPhone,
        medicalNotes: row.waiver?.medicalNotes ?? null,
        waiverStatus: row.waiver ? ('SIGNED' as const) : ('PENDING' as const),
        balanceDueCents: index === 0 ? balance : 0,
        currency: b.currency,
      }));
    });
    return { departure: toDepartureDto(departure, counts.get(id)), passengers };
  }
}
