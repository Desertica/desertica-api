import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../auth/auth.types';
import { SeatsService } from '../catalog/seats.service';
import { CancelDepartureDto } from '../admin/dto/admin.dto';
import { toJson } from './booking-support';
import { BookingLifecycleService } from './booking-lifecycle.service';

const ACTIVE = ['PENDING_PAYMENT', 'CONFIRMED'] as const;
type Tx = Prisma.TransactionClient;

/**
 * Cancelación de una salida por decisión de la empresa. En una sola
 * transacción cierra la salida, libera sus bloqueos y resuelve cada reserva
 * vigente según `resolution`. Los correos salen al terminar.
 */
@Injectable()
export class DepartureCancellationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly seats: SeatsService,
    private readonly audit: AuditService,
    private readonly lifecycle: BookingLifecycleService,
  ) {}

  async cancel(
    departureId: string,
    dto: CancelDepartureDto,
    actor: AuthUser,
    ip?: string,
    now = new Date(),
  ) {
    if (dto.resolution === 'RESCHEDULE' && !dto.targetDepartureId) {
      throw new UnprocessableEntityException(
        'targetDepartureId is required to reschedule',
      );
    }
    if (dto.resolution !== 'RESCHEDULE' && dto.targetDepartureId) {
      throw new UnprocessableEntityException(
        'targetDepartureId only applies to RESCHEDULE',
      );
    }
    if (dto.targetDepartureId === departureId) {
      throw new UnprocessableEntityException(
        'The target must be a different departure',
      );
    }

    const bookingIds = await this.runWithRetry(() =>
      this.prisma.$transaction((tx) =>
        this.cancelInTx(tx, departureId, dto, actor, ip, now),
      ),
    );

    // Después de confirmar: un correo caído no deshace la cancelación.
    const template =
      dto.resolution === 'REFUND'
        ? 'booking_cancelled'
        : dto.resolution === 'RESCHEDULE'
          ? 'booking_rescheduled'
          : 'departure_cancelled';
    for (const id of bookingIds) {
      const refundDue =
        dto.resolution === 'REFUND' ? await this.refundDue(id) : undefined;
      await this.lifecycle.notifyCustomer(id, template, {
        reason: dto.reason,
        ...(refundDue === undefined ? {} : { refundDueCents: refundDue }),
        ...(dto.resolution === 'RESCHEDULE' ? { adjustment: null } : {}),
      });
    }
    return { affectedBookings: bookingIds.length };
  }

  private async refundDue(bookingId: string): Promise<number> {
    const sum = await this.prisma.refund.aggregate({
      where: { status: 'PENDING', payment: { bookingId } },
      _sum: { amountCents: true },
    });
    return sum._sum.amountCents ?? 0;
  }

  /** Un abrazo mortal con otra operación sobre las mismas filas se reintenta una vez. */
  private async runWithRetry<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2034'
      ) {
        return run();
      }
      throw error;
    }
  }

  private async cancelInTx(
    tx: Tx,
    departureId: string,
    dto: CancelDepartureDto,
    actor: AuthUser,
    ip: string | undefined,
    now: Date,
  ): Promise<string[]> {
    // Candados de salidas en orden fijo (origen y destino).
    for (const id of [departureId, dto.targetDepartureId]
      .filter((x): x is string => !!x)
      .sort()) {
      if (!(await this.seats.lockDeparture(tx, id))) {
        if (id === departureId)
          throw new NotFoundException('Departure not found');
        throw new UnprocessableEntityException('Unknown targetDepartureId');
      }
    }
    const departure = await tx.departure.findUniqueOrThrow({
      where: { id: departureId },
    });
    if (departure.status === 'CANCELLED' || departure.status === 'COMPLETED') {
      throw new ConflictException(`Departure is ${departure.status}`);
    }

    // Reservas de la salida congeladas (orden por id para no cruzarse con otro barrido).
    await tx.$queryRaw`
      SELECT "id" FROM "Booking" WHERE "departureId" = ${departureId}
      ORDER BY "id" FOR UPDATE`;
    const bookings = await tx.booking.findMany({
      where: { departureId, status: { in: [...ACTIVE] } },
      orderBy: { id: 'asc' },
    });

    let target: { id: string } | null = null;
    if (dto.resolution === 'RESCHEDULE') {
      const found = await tx.departure.findUniqueOrThrow({
        where: { id: dto.targetDepartureId! },
      });
      if (found.tourRefId !== departure.tourRefId) {
        throw new UnprocessableEntityException(
          'The target must be a departure of the same tour',
        );
      }
      if (found.status === 'CANCELLED' || found.status === 'COMPLETED') {
        throw new ConflictException(`The target departure is ${found.status}`);
      }
      if (found.startsAt <= now) {
        throw new ConflictException('The target departure already started');
      }
      const people = bookings.reduce((n, b) => n + b.adults + b.children, 0);
      const counts = (await this.seats.countFor([found.id], now, tx)).get(
        found.id,
      )!;
      const left = found.capacity - counts.sold - counts.held;
      if (people > left) {
        throw new ConflictException({
          message: 'Not enough seats on the target departure',
          details: { seatsNeeded: people, seatsLeft: Math.max(0, left) },
        });
      }
      target = found;
    }

    await tx.departure.update({
      where: { id: departureId },
      data: { status: 'CANCELLED' },
    });
    // Los bloqueos sin reserva dejan de retener cupo y fallan al intentar pagar.
    await tx.hold.updateMany({
      where: { departureId, releasedAt: null, booking: { is: null } },
      data: { releasedAt: now },
    });

    for (const booking of bookings) {
      if (dto.resolution === 'REFUND') {
        const pending = await tx.refund.aggregate({
          where: { status: 'PENDING', payment: { bookingId: booking.id } },
          _sum: { amountCents: true },
        });
        const alreadyOut =
          booking.refundedCents + (pending._sum.amountCents ?? 0);
        const refundCents = Math.max(0, booking.paidCents - alreadyOut);
        await this.lifecycle.createPendingRefunds(
          tx,
          booking.id,
          refundCents,
          dto.reason,
          { mode: 'DEPARTURE_CANCELLED' },
          actor.id,
        );
        await tx.booking.update({
          where: { id: booking.id },
          data: {
            status: 'CANCELLED',
            cancelledAt: now,
            cancelReason: dto.reason,
          },
        });
        if (booking.holdId) {
          await tx.hold.update({
            where: { id: booking.holdId },
            data: { releasedAt: now },
          });
        }
        await this.audit.record(
          {
            actorUserId: actor.id,
            action: 'booking.cancel',
            entity: 'Booking',
            entityId: booking.id,
            before: { status: booking.status, paidCents: booking.paidCents },
            after: {
              status: 'CANCELLED',
              reason: dto.reason,
              refundMode: 'DEPARTURE_CANCELLED',
              refundDueCents: refundCents,
            },
            ip,
          },
          tx,
        );
      } else if (dto.resolution === 'RESCHEDULE' && target) {
        const snapshot = booking.priceSnapshot as Record<string, unknown>;
        const history: unknown[] = Array.isArray(snapshot.rescheduled)
          ? (snapshot.rescheduled as unknown[])
          : [];
        // Cambio decidido por la empresa: el cliente conserva su precio.
        await tx.booking.update({
          where: { id: booking.id },
          data: {
            departureId: target.id,
            priceSnapshot: toJson({
              ...snapshot,
              rescheduled: [
                ...history,
                {
                  at: now.toISOString(),
                  fromDepartureId: departureId,
                  toDepartureId: target.id,
                  previousTotalCents: booking.totalCents,
                  byUserId: actor.id,
                  cause: 'DEPARTURE_CANCELLED',
                },
              ],
            }),
          },
        });
        await this.audit.record(
          {
            actorUserId: actor.id,
            action: 'booking.reschedule',
            entity: 'Booking',
            entityId: booking.id,
            before: { departureId, totalCents: booking.totalCents },
            after: {
              departureId: target.id,
              totalCents: booking.totalCents,
              reason: dto.reason,
            },
            ip,
          },
          tx,
        );
      }
    }

    await this.audit.record(
      {
        actorUserId: actor.id,
        action: 'departure.cancel',
        entity: 'Departure',
        entityId: departureId,
        before: { status: departure.status },
        after: {
          status: 'CANCELLED',
          resolution: dto.resolution,
          reason: dto.reason,
          affectedBookings: bookings.length,
          targetDepartureId: target?.id ?? null,
        },
        ip,
      },
      tx,
    );
    return bookings.map((b) => b.id);
  }
}
