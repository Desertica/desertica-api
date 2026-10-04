import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  computeRefund,
  priceBooking,
  priceDifference,
  type CancellationTier,
} from '../../common/money';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../auth/auth.types';
import { AvailabilityService } from '../catalog/availability.service';
import { SeatsService } from '../catalog/seats.service';
import { NotificationsService } from '../notifications/notifications.service';
import { BookingViewService } from './booking-view.service';
import { normalizeEmail, toJson, validateBilling } from './booking-support';
import {
  CancelBookingDto,
  RescheduleBookingDto,
  SetBookingStatusDto,
  UpdateBookingDto,
} from './dto/booking.dto';
import { allocateRefund } from './refund-allocation';

type Tx = Prisma.TransactionClient;
const ACTIVE = ['PENDING_PAYMENT', 'CONFIRMED'];

@Injectable()
export class BookingLifecycleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly seats: SeatsService,
    private readonly availability: AvailabilityService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly view: BookingViewService,
  ) {}

  private async lockBooking(tx: Tx, id: string): Promise<void> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "Booking" WHERE "id" = ${id} FOR UPDATE`;
    if (rows.length === 0) throw new NotFoundException('Booking not found');
  }

  /** Reembolsos pendientes por pago, para no prometer dos veces el mismo dinero. */
  private async refundablePayments(tx: Tx, bookingId: string) {
    const payments = await tx.payment.findMany({
      where: {
        bookingId,
        status: { in: ['SUCCEEDED', 'PARTIALLY_REFUNDED'] },
      },
      orderBy: { createdAt: 'asc' },
      include: {
        refunds: {
          where: { status: 'PENDING' },
          select: { amountCents: true },
        },
      },
    });
    return payments.map((p) => ({
      id: p.id,
      refundableCents:
        p.amountCents -
        p.refundedCents -
        p.refunds.reduce((sum, r) => sum + r.amountCents, 0),
    }));
  }

  private async createPendingRefunds(
    tx: Tx,
    bookingId: string,
    amountCents: number,
    reason: string,
    policyTier: Prisma.InputJsonValue,
    requestedByUserId: string | null,
  ): Promise<number> {
    if (amountCents <= 0) return 0;
    const plan = allocateRefund(
      await this.refundablePayments(tx, bookingId),
      amountCents,
    );
    if (!plan) {
      throw new ConflictException('The refund exceeds what is refundable');
    }
    for (const part of plan) {
      await tx.refund.create({
        data: {
          paymentId: part.paymentId,
          amountCents: part.amountCents,
          reason,
          status: 'PENDING',
          policyTier,
          requestedByUserId,
        },
      });
    }
    return amountCents;
  }

  // ---------------------------------------------------------- Editar

  async update(
    id: string,
    dto: UpdateBookingDto,
    actor: AuthUser,
    ip?: string,
  ) {
    if (dto.billing) validateBilling(dto.billing);
    await this.prisma.$transaction(async (tx) => {
      await this.lockBooking(tx, id);
      const before = await tx.booking.findUniqueOrThrow({
        where: { id },
        include: { customer: true, passengers: true, waivers: true },
      });
      // Completadas y no-show se pueden anotar; las canceladas no se editan.
      if (before.status === 'CANCELLED') {
        throw new ConflictException('A cancelled booking cannot be edited');
      }
      const changed: string[] = [];
      const data: Prisma.BookingUpdateInput = {};
      if (dto.notes !== undefined) {
        data.notes = dto.notes;
        changed.push('notes');
      }
      if (dto.billing) {
        data.billing = toJson(dto.billing);
        changed.push('billing');
      }
      if (dto.customer) {
        await tx.customer.update({
          where: { id: before.customerId },
          data: {
            email: normalizeEmail(dto.customer.email),
            firstName: dto.customer.firstName.trim(),
            lastName: dto.customer.lastName.trim(),
            phone: dto.customer.phone ?? null,
            country: dto.customer.country?.toUpperCase() ?? null,
            idDocType: dto.customer.idDocType ?? null,
            idDocNumber: dto.customer.idDocNumber ?? null,
            ...(dto.customer.locale ? { locale: dto.customer.locale } : {}),
          },
        });
        changed.push('customer');
      }
      if (dto.passengers) {
        const people = before.adults + before.children;
        if (dto.passengers.length > people) {
          throw new UnprocessableEntityException(
            'There are more passengers than seats',
          );
        }
        if (before.waivers.some((w) => w.status === 'SIGNED')) {
          throw new ConflictException(
            'Passengers cannot be replaced once a waiver was signed',
          );
        }
        await tx.passenger.deleteMany({ where: { bookingId: id } });
        const ids: string[] = [];
        for (const p of dto.passengers) {
          const created = await tx.passenger.create({
            data: {
              bookingId: id,
              firstName: p.firstName,
              lastName: p.lastName,
              idDocType: p.idDocType,
              idDocNumber: p.idDocNumber,
              birthDate: p.birthDate
                ? new Date(`${p.birthDate}T00:00:00.000Z`)
                : null,
              nationality: p.nationality,
              emergencyContactName: p.emergencyContactName,
              emergencyContactPhone: p.emergencyContactPhone,
            },
          });
          ids.push(created.id);
        }
        const waivers = await tx.waiver.findMany({
          where: { bookingId: id },
          orderBy: { createdAt: 'asc' },
        });
        for (const [i, waiver] of waivers.entries()) {
          await tx.waiver.update({
            where: { id: waiver.id },
            data: { passengerId: ids[i] ?? null },
          });
        }
        changed.push('passengers');
      }
      if (Object.keys(data).length > 0) {
        await tx.booking.update({ where: { id }, data });
      }
      await this.audit.record(
        {
          actorUserId: actor.id,
          action: 'booking.update',
          entity: 'Booking',
          entityId: id,
          before: {
            fields: changed,
            ...(changed.includes('notes') ? { notes: before.notes } : {}),
            ...(changed.includes('billing') ? { billing: before.billing } : {}),
          },
          after: {
            fields: changed,
            ...(changed.includes('notes') ? { notes: dto.notes } : {}),
            ...(changed.includes('billing') ? { billing: dto.billing } : {}),
          },
          ip,
        },
        tx,
      );
    });
    return this.view.get(id);
  }

  // -------------------------------------------------------- Cancelar

  /**
   * Reembolso de una cancelación. Lo usan `cancel` (que luego registra las
   * filas `Refund`) y `quoteCancellation` (que solo calcula).
   */
  private computeCancellation(
    booking: {
      paidCents: number;
      depositCents: number | null;
      cancellationSnapshot: Prisma.JsonValue;
      departure: { startsAt: Date };
    },
    alreadyOut: number,
    mode: 'POLICY' | 'FULL' | 'NONE',
    now: Date,
  ) {
    const snapshot = booking.cancellationSnapshot as {
      version?: number;
      tiers?: CancellationTier[];
      depositRefundable?: boolean;
    };
    const hoursUntil =
      (booking.departure.startsAt.getTime() - now.getTime()) / 3_600_000;
    const policyVersion = snapshot.version ?? null;
    const percentOfPaid = (cents: number) =>
      booking.paidCents > 0 ? Math.round((cents * 100) / booking.paidCents) : 0;

    if (mode === 'NONE') {
      return {
        refundCents: 0,
        refundPercent: 0,
        tier: null,
        policyVersion,
        reason: 'NONE_REQUESTED' as string | null,
        audit: { mode } as Prisma.InputJsonValue,
      };
    }
    if (mode === 'FULL') {
      const refundCents = Math.max(0, booking.paidCents - alreadyOut);
      return {
        refundCents,
        refundPercent: percentOfPaid(refundCents),
        tier: null,
        policyVersion,
        reason: refundCents === 0 ? 'NOTHING_TO_REFUND' : null,
        audit: { mode } as Prisma.InputJsonValue,
      };
    }
    const result = computeRefund({
      paidCents: booking.paidCents,
      refundedCents: Math.min(alreadyOut, booking.paidCents),
      depositCents: booking.depositCents,
      depositRefundable: snapshot.depositRefundable ?? false,
      tiers: snapshot.tiers ?? [],
      hoursUntilDeparture: hoursUntil,
    });
    let reason: string | null = null;
    if (result.refundCents === 0) {
      if (booking.paidCents === 0) reason = 'NO_PAYMENTS';
      else if (!(snapshot.tiers?.length ?? 0)) reason = 'NO_POLICY';
      else if (result.refundPercent === 0) reason = 'OUTSIDE_POLICY_WINDOW';
      else reason = 'NOTHING_TO_REFUND';
    }
    return {
      refundCents: result.refundCents,
      // Porcentaje del tramo aplicado (no de lo pagado): es lo que explica la política.
      refundPercent: result.refundPercent,
      tier: result.tier,
      policyVersion,
      reason,
      audit: toJson({
        mode: 'POLICY',
        tier: result.tier,
        refundPercent: result.refundPercent,
        hoursUntilDeparture: Math.round(hoursUntil * 100) / 100,
      }),
    };
  }

  /** Cuánto se reembolsaría al cancelar, sin cambiar nada. */
  async quoteCancellation(
    id: string,
    mode: 'POLICY' | 'FULL' | 'NONE' = 'POLICY',
    now = new Date(),
  ) {
    const booking = await this.prisma.booking.findUnique({
      where: { id },
      include: { departure: true },
    });
    if (!booking) throw new NotFoundException('Booking not found');
    if (!ACTIVE.includes(booking.status)) {
      throw new ConflictException(
        `A ${booking.status} booking cannot be cancelled`,
      );
    }
    const pendingRefunds = await this.prisma.refund.aggregate({
      where: { status: 'PENDING', payment: { bookingId: id } },
      _sum: { amountCents: true },
    });
    const alreadyOut =
      booking.refundedCents + (pendingRefunds._sum.amountCents ?? 0);
    const calc = this.computeCancellation(booking, alreadyOut, mode, now);
    return {
      currency: booking.currency,
      paidCents: booking.paidCents,
      refundCents: calc.refundCents,
      refundPercent: calc.refundPercent,
      tier: calc.tier
        ? {
            hoursBefore: calc.tier.hoursBefore,
            refundPercent: calc.tier.refundPercent,
          }
        : null,
      policyVersion: calc.policyVersion,
      reason: calc.reason,
    };
  }

  async cancel(
    id: string,
    dto: CancelBookingDto,
    actor: AuthUser,
    ip?: string,
    now = new Date(),
  ) {
    if (
      dto.refund !== 'POLICY' &&
      !actor.permissions.has('bookings:override')
    ) {
      throw new ForbiddenException({
        message: 'Missing permission',
        details: { required: ['bookings:override'] },
      });
    }
    await this.prisma.$transaction(async (tx) => {
      await this.lockBooking(tx, id);
      const booking = await tx.booking.findUniqueOrThrow({
        where: { id },
        include: { departure: true },
      });
      if (!ACTIVE.includes(booking.status)) {
        throw new ConflictException(
          `A ${booking.status} booking cannot be cancelled`,
        );
      }
      const pendingRefunds = await tx.refund.aggregate({
        where: { status: 'PENDING', payment: { bookingId: id } },
        _sum: { amountCents: true },
      });
      const alreadyOut =
        booking.refundedCents + (pendingRefunds._sum.amountCents ?? 0);
      const calc = this.computeCancellation(
        booking,
        alreadyOut,
        dto.refund,
        now,
      );
      const refundCents = calc.refundCents;
      const policyTier: Prisma.InputJsonValue = calc.audit;
      await this.createPendingRefunds(
        tx,
        id,
        refundCents,
        dto.reason,
        policyTier,
        actor.id,
      );

      await tx.booking.update({
        where: { id },
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
          entityId: id,
          before: { status: booking.status, paidCents: booking.paidCents },
          after: {
            status: 'CANCELLED',
            reason: dto.reason,
            refundMode: dto.refund,
            refundDueCents: refundCents,
          },
          ip,
        },
        tx,
      );
    });

    const full = await this.view.get(id);
    await this.notifyCustomer(id, 'booking_cancelled', {
      refundDueCents: full.refundDueCents,
    });
    return full;
  }

  // --------------------------------------------------- Reprogramar

  async reschedule(
    id: string,
    dto: RescheduleBookingDto,
    actor: AuthUser,
    ip?: string,
    now = new Date(),
  ) {
    let adjustment:
      { type: 'CHARGE' | 'REFUND'; amountCents: number } | undefined;

    await this.prisma.$transaction(async (tx) => {
      await this.lockBooking(tx, id);
      const booking = await tx.booking.findUniqueOrThrow({
        where: { id },
        include: { departure: true },
      });
      if (!ACTIVE.includes(booking.status)) {
        throw new ConflictException(
          `A ${booking.status} booking cannot be rescheduled`,
        );
      }
      if (booking.departureId === dto.targetDepartureId) {
        throw new UnprocessableEntityException(
          'The booking is already on that departure',
        );
      }
      // Candados en orden fijo para no entrar en un abrazo mortal con otra reprogramación.
      for (const depId of [booking.departureId, dto.targetDepartureId].sort()) {
        if (!(await this.seats.lockDeparture(tx, depId))) {
          throw new UnprocessableEntityException('Unknown targetDepartureId');
        }
      }
      const target = await tx.departure.findUniqueOrThrow({
        where: { id: dto.targetDepartureId },
      });
      if (target.tourRefId !== booking.departure.tourRefId) {
        throw new UnprocessableEntityException(
          'The target must be a departure of the same tour',
        );
      }
      if (target.status === 'CANCELLED' || target.status === 'COMPLETED') {
        throw new ConflictException(`The target departure is ${target.status}`);
      }
      if (target.startsAt <= now) {
        throw new ConflictException('The target departure already started');
      }
      const people = booking.adults + booking.children;
      const counts = (await this.seats.countFor([target.id], now, tx)).get(
        target.id,
      )!;
      if (people > target.capacity - counts.sold - counts.held) {
        throw new ConflictException('Not enough seats on the target departure');
      }

      const snapshot = booking.priceSnapshot as Record<string, unknown>;
      let newTotal = booking.totalCents;
      let newLines: unknown = snapshot.lines;
      if (!snapshot.override) {
        const { rule } = await this.availability.priceFor(
          target,
          booking.currency,
          people,
        );
        const price = priceBooking(rule, booking.adults, booking.children);
        newTotal = price.totalCents;
        newLines = price.lines;
      }
      const diff = priceDifference(booking.totalCents, newTotal);

      if (diff.type === 'REFUND') {
        if (!actor.permissions.has('payments:refund')) {
          throw new ForbiddenException({
            message: 'Missing permission',
            details: { required: ['payments:refund'] },
          });
        }
        const net = booking.paidCents - booking.refundedCents;
        const due = Math.min(diff.amountCents, Math.max(0, net - newTotal));
        await this.createPendingRefunds(
          tx,
          id,
          due,
          dto.reason ?? 'Price difference after rescheduling',
          { mode: 'RESCHEDULE_DIFFERENCE' },
          actor.id,
        );
      }
      if (diff.type !== 'NONE') {
        adjustment = { type: diff.type, amountCents: diff.amountCents };
      }

      const history: unknown[] = Array.isArray(snapshot.rescheduled)
        ? (snapshot.rescheduled as unknown[])
        : [];
      await tx.booking.update({
        where: { id },
        data: {
          departureId: target.id,
          totalCents: newTotal,
          depositCents:
            booking.depositCents === null
              ? null
              : Math.min(booking.depositCents, newTotal),
          priceSnapshot: toJson({
            ...snapshot,
            lines: newLines,
            totalCents: newTotal,
            rescheduled: [
              ...history,
              {
                at: now.toISOString(),
                fromDepartureId: booking.departureId,
                toDepartureId: target.id,
                previousTotalCents: booking.totalCents,
                byUserId: actor.id,
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
          entityId: id,
          before: {
            departureId: booking.departureId,
            totalCents: booking.totalCents,
          },
          after: {
            departureId: target.id,
            totalCents: newTotal,
            reason: dto.reason ?? null,
          },
          ip,
        },
        tx,
      );
    });

    await this.notifyCustomer(id, 'booking_rescheduled', {
      adjustment: adjustment ?? null,
    });
    return {
      booking: await this.view.get(id),
      ...(adjustment ? { adjustment } : {}),
    };
  }

  // ----------------------------------------------------- Completar

  async setStatus(
    id: string,
    dto: SetBookingStatusDto,
    actor: AuthUser,
    ip?: string,
    now = new Date(),
  ) {
    await this.prisma.$transaction(async (tx) => {
      await this.lockBooking(tx, id);
      const booking = await tx.booking.findUniqueOrThrow({
        where: { id },
        include: { departure: true },
      });
      if (booking.status !== 'CONFIRMED') {
        throw new ConflictException(
          `Only CONFIRMED bookings can be marked ${dto.status} (it is ${booking.status})`,
        );
      }
      if (booking.departure.startsAt > now) {
        throw new ConflictException('The departure has not started yet');
      }
      await tx.booking.update({ where: { id }, data: { status: dto.status } });
      await this.audit.record(
        {
          actorUserId: actor.id,
          action: 'booking.status',
          entity: 'Booking',
          entityId: id,
          before: { status: booking.status },
          after: { status: dto.status },
          ip,
        },
        tx,
      );
    });
    return this.view.get(id);
  }

  // -------------------------------------------------------- Correo

  private async notifyCustomer(
    bookingId: string,
    template: string,
    extra: Record<string, unknown>,
  ) {
    const b = await this.prisma.booking.findUniqueOrThrow({
      where: { id: bookingId },
      include: { customer: true, departure: { include: { tourRef: true } } },
    });
    await this.notifications.sendEmail(
      {
        to: b.customer.email,
        template,
        locale: b.locale,
        data: {
          reference: b.reference,
          tourSlug: b.departure.tourRef.slug,
          startsAt: b.departure.startsAt.toISOString(),
          currency: b.currency,
          totalCents: b.totalCents,
          ...extra,
        },
      },
      { bookingId },
    );
  }
}
