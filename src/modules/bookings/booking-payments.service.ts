import {
  ConflictException,
  GoneException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { pendingCents } from '../../common/money';
import { IdempotencyService } from '../../common/idempotency/idempotency.service';
import { EnvVars } from '../../config/env.validation';
import { Prisma } from '../../generated/prisma/client';
import { PaymentKind } from '../../generated/prisma/enums';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../auth/auth.types';
import { NotificationsService } from '../notifications/notifications.service';
import { bookingPending, toPaymentDto } from './booking.mappers';
import { generateToken } from './booking-support';
import { CreatePaymentLinkDto, ManualPaymentDto } from './dto/booking.dto';
import { links } from './links';

type Tx = Prisma.TransactionClient;

/** Pagado, descontando lo ya devuelto. */
const netPaid = (b: { paidCents: number; refundedCents: number }) =>
  b.paidCents - b.refundedCents;

/**
 * Importe que debe estar pagado para que la reserva quede confirmada: el
 * depósito si se eligió pagar en dos partes, si no el total.
 */
export const confirmationThreshold = (b: {
  totalCents: number;
  depositCents: number | null;
}) => b.depositCents ?? b.totalCents;

@Injectable()
export class BookingPaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
    private readonly notifications: NotificationsService,
    private readonly config: ConfigService<EnvVars, true>,
  ) {}

  /**
   * Acredita un pago exitoso a la reserva y la confirma si ya cubre el
   * depósito (o el total). El webhook de las pasarelas (Ola 2) reutiliza esta
   * función: la reserva debe estar bloqueada por el llamador.
   */
  async applySucceededPayment(
    tx: Tx,
    booking: {
      id: string;
      status: string;
      paidCents: number;
      refundedCents: number;
      totalCents: number;
      depositCents: number | null;
    },
    amountCents: number,
  ): Promise<{ confirmed: boolean; paidCents: number }> {
    const paidCents = booking.paidCents + amountCents;
    const confirmed =
      booking.status === 'PENDING_PAYMENT' &&
      paidCents - booking.refundedCents >= confirmationThreshold(booking);
    await tx.booking.update({
      where: { id: booking.id },
      data: { paidCents, ...(confirmed ? { status: 'CONFIRMED' } : {}) },
    });
    return { confirmed, paidCents };
  }

  // ------------------------------------------------------ Pago manual

  async recordManual(
    bookingId: string,
    dto: ManualPaymentDto,
    actor: AuthUser,
    ctx: { ip?: string; idempotencyKey?: string },
  ) {
    const result = await this.idempotency.run(
      {
        scope: `recordManualPayment:${bookingId}`,
        key: ctx.idempotencyKey,
        request: dto,
      },
      async (tx) => {
        const locked = await tx.$queryRaw<{ id: string }[]>`
          SELECT "id" FROM "Booking" WHERE "id" = ${bookingId} FOR UPDATE`;
        if (locked.length === 0)
          throw new NotFoundException('Booking not found');
        const booking = await tx.booking.findUniqueOrThrow({
          where: { id: bookingId },
        });
        if (
          booking.status !== 'PENDING_PAYMENT' &&
          booking.status !== 'CONFIRMED'
        ) {
          throw new ConflictException(
            `A ${booking.status} booking cannot receive payments`,
          );
        }
        if (dto.currency !== booking.currency) {
          throw new ConflictException(
            `The booking is in ${booking.currency}, not ${dto.currency}`,
          );
        }
        if (dto.kind === 'DEPOSIT' && booking.depositCents === null) {
          throw new UnprocessableEntityException('The booking has no deposit');
        }
        const pending = pendingCents(
          booking.totalCents,
          booking.paidCents,
          booking.refundedCents,
        );
        if (dto.amountCents > pending) {
          throw new ConflictException({
            message: 'The amount exceeds the pending balance',
            details: { pendingCents: pending },
          });
        }
        if (dto.reference) {
          const duplicate = await tx.payment.findUnique({
            where: {
              provider_providerRef: {
                provider: 'MANUAL',
                providerRef: dto.reference,
              },
            },
          });
          if (duplicate) {
            throw new ConflictException(
              'That operation reference was already recorded',
            );
          }
        }

        const payment = await tx.payment.create({
          data: {
            bookingId,
            provider: 'MANUAL',
            method: dto.method,
            kind: dto.kind,
            status: 'SUCCEEDED',
            currency: dto.currency,
            amountCents: dto.amountCents,
            providerRef: dto.reference ?? null,
            recordedByUserId: actor.id,
            paidAt: dto.paidAt ? new Date(dto.paidAt) : new Date(),
          },
        });
        const applied = await this.applySucceededPayment(
          tx,
          booking,
          dto.amountCents,
        );
        await this.audit.record(
          {
            actorUserId: actor.id,
            action: 'payment.manual',
            entity: 'Payment',
            entityId: payment.id,
            before: {
              bookingStatus: booking.status,
              paidCents: booking.paidCents,
            },
            after: {
              bookingId,
              method: dto.method,
              kind: dto.kind,
              amountCents: dto.amountCents,
              currency: dto.currency,
              reference: dto.reference ?? null,
              bookingStatus: applied.confirmed ? 'CONFIRMED' : booking.status,
              paidCents: applied.paidCents,
            },
            ip: ctx.ip,
          },
          tx,
        );
        return {
          status: 201,
          body: {
            ...toPaymentDto(payment, booking.reference),
            _confirmed: applied.confirmed,
          },
        };
      },
    );

    const { _confirmed, ...body } = result.body;
    if (_confirmed && !result.replayed) {
      await this.sendConfirmedEmail(bookingId);
    }
    return { status: result.status, body };
  }

  private async sendConfirmedEmail(bookingId: string) {
    const b = await this.prisma.booking.findUniqueOrThrow({
      where: { id: bookingId },
      include: { customer: true, departure: { include: { tourRef: true } } },
    });
    await this.notifications.sendEmail(
      {
        to: b.customer.email,
        template: 'booking_confirmed',
        locale: b.locale,
        data: {
          reference: b.reference,
          tourSlug: b.departure.tourRef.slug,
          startsAt: b.departure.startsAt.toISOString(),
          currency: b.currency,
          totalCents: b.totalCents,
          paidCents: b.paidCents,
        },
      },
      { bookingId },
    );
  }

  // ------------------------------------------------- Enlaces de pago

  /** Monto pendiente del tipo pedido. */
  private defaultAmount(
    kind: PaymentKind,
    b: {
      totalCents: number;
      depositCents: number | null;
      paidCents: number;
      refundedCents: number;
    },
  ): number {
    const net = netPaid(b);
    if (kind === 'DEPOSIT') return Math.max(0, (b.depositCents ?? 0) - net);
    return Math.max(0, b.totalCents - net); // FULL y BALANCE
  }

  async createLink(
    bookingId: string,
    dto: CreatePaymentLinkDto,
    actor: AuthUser,
  ) {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      include: { customer: true, departure: { include: { tourRef: true } } },
    });
    if (!booking) throw new NotFoundException('Booking not found');
    if (
      booking.status !== 'PENDING_PAYMENT' &&
      booking.status !== 'CONFIRMED'
    ) {
      throw new ConflictException(`A ${booking.status} booking cannot be paid`);
    }
    if (dto.kind === 'DEPOSIT' && booking.depositCents === null) {
      throw new UnprocessableEntityException('The booking has no deposit');
    }
    const pending = pendingCents(
      booking.totalCents,
      booking.paidCents,
      booking.refundedCents,
    );
    const amountCents =
      dto.amountCents ?? this.defaultAmount(dto.kind, booking);
    if (amountCents <= 0) {
      throw new ConflictException('There is nothing pending of that kind');
    }
    if (amountCents > pending) {
      throw new UnprocessableEntityException({
        message: 'The amount exceeds the pending balance',
        details: { pendingCents: pending },
      });
    }
    const expiresAt = new Date(
      Date.now() + (dto.expiresInHours ?? 48) * 3_600_000,
    );
    const link = await this.prisma.$transaction(async (tx) => {
      // Se vuelve a comprobar bajo candado: un pago simultáneo pudo bajar el saldo.
      await tx.$queryRaw`SELECT "id" FROM "Booking" WHERE "id" = ${bookingId} FOR UPDATE`;
      const fresh = await tx.booking.findUniqueOrThrow({
        where: { id: bookingId },
      });
      if (
        amountCents >
        pendingCents(fresh.totalCents, fresh.paidCents, fresh.refundedCents)
      ) {
        throw new ConflictException('The pending balance changed');
      }
      const created = await tx.paymentLink.create({
        data: {
          token: generateToken(24),
          bookingId,
          kind: dto.kind,
          currency: booking.currency,
          amountCents,
          expiresAt,
          createdByUserId: actor.id,
        },
      });
      await this.audit.record(
        {
          actorUserId: actor.id,
          action: 'paymentLink.create',
          entity: 'PaymentLink',
          entityId: created.id,
          after: { bookingId, kind: dto.kind, amountCents, expiresAt },
        },
        tx,
      );
      return created;
    });

    const url = links.payment(
      this.config.get('PUBLIC_WEB_URL', { infer: true }),
      link.token,
    );
    await this.notifications.sendEmail(
      {
        to: booking.customer.email,
        template: 'payment_link',
        locale: booking.locale,
        data: {
          reference: booking.reference,
          tourSlug: booking.departure.tourRef.slug,
          kind: link.kind,
          currency: link.currency,
          amountCents: link.amountCents,
          expiresAt: link.expiresAt.toISOString(),
          paymentUrl: url,
        },
      },
      { bookingId },
    );
    return {
      id: link.id,
      token: link.token,
      url,
      kind: link.kind,
      currency: link.currency,
      amountCents: link.amountCents,
      expiresAt: link.expiresAt,
      usedAt: link.usedAt,
    };
  }

  /** Datos públicos de un enlace de pago (para mostrar antes de cobrar). */
  async linkInfo(token: string, now = new Date()) {
    const link = await this.prisma.paymentLink.findUnique({
      where: { token },
      include: {
        booking: { include: { departure: { include: { tourRef: true } } } },
      },
    });
    if (!link) throw new NotFoundException('Payment link not found');
    const pending = bookingPending(link.booking);
    if (link.usedAt || link.expiresAt <= now || pending <= 0) {
      throw new GoneException('The payment link expired or was already used');
    }
    return {
      reference: link.booking.reference,
      tourSlug: link.booking.departure.tourRef.slug,
      startsAt: link.booking.departure.startsAt,
      kind: link.kind,
      currency: link.currency,
      // Nunca más que el saldo de hoy.
      amountCents: Math.min(link.amountCents, pending),
      expiresAt: link.expiresAt,
      paymentOptions: [...(link.currency === 'USD' ? ['STRIPE'] : []), 'CULQI'],
    };
  }
}
