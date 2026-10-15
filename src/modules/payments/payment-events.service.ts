import { Injectable, Logger } from '@nestjs/common';
import { pendingCents } from '../../common/money';
import { Prisma } from '../../generated/prisma/client';
import type {
  PaymentProvider,
  PaymentStatus,
} from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { BookingPaymentsService } from '../bookings/booking-payments.service';
import { SeatsService } from '../catalog/seats.service';
import { DocumentsService } from '../documents/documents.service';
import { GatewayRegistry } from './gateway.registry';
import type { GatewayEvent, GatewayPayment } from './providers/payment-gateway';
import { DisputesService } from './disputes.service';
import { RefundsService } from './refunds-admin.service';
import { SETTLED, newEffects, type Effects } from './payment-state';
import { RefundsExecutor } from './refunds.service';
import { StaffAlertsService } from '../alerts/staff-alerts.service';

type Tx = Prisma.TransactionClient;
type PaymentRow = Prisma.PaymentGetPayload<object>;

const OPEN_PAYMENT: PaymentStatus[] = ['PENDING', 'REQUIRES_ACTION'];

/**
 * Procesa eventos de las pasarelas: el estado de un pago lo fija esto (el
 * webhook, o el resultado de la llamada servidor a servidor de Culqi), nunca el
 * navegador. Cada evento se guarda en `WebhookEvent` (idempotente por
 * `provider` y `eventId`) y se aplica en una sola transacción, con la reserva
 * bloqueada y la auditoría dentro.
 */
@Injectable()
export class PaymentEventsService {
  private readonly logger = new Logger(PaymentEventsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gateways: GatewayRegistry,
    private readonly bookingPayments: BookingPaymentsService,
    private readonly seats: SeatsService,
    private readonly audit: AuditService,
    private readonly alerts: StaffAlertsService,
    private readonly refunds: RefundsExecutor,
    private readonly refundEvents: RefundsService,
    private readonly disputes: DisputesService,
    private readonly documents: DocumentsService,
  ) {}

  /** Punto de entrada del webhook: valida la firma y procesa. */
  async receive(
    provider: 'STRIPE' | 'CULQI',
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
  ): Promise<{ duplicate: boolean }> {
    const event = await this.gateways
      .get(provider)
      .parseWebhook(rawBody, headers);
    return this.process(provider, event);
  }

  async process(
    provider: PaymentProvider,
    event: GatewayEvent,
  ): Promise<{ duplicate: boolean }> {
    await this.prisma.webhookEvent.createMany({
      data: [
        {
          provider,
          eventId: event.eventId,
          type: event.type,
          payload: this.storable(event),
        },
      ],
      skipDuplicates: true,
    });

    let effects: Effects | null;
    try {
      effects = await this.prisma.$transaction(
        async (tx) => {
          // Un evento a la vez: un duplicado simultáneo espera aquí y lo ve procesado.
          const rows = await tx.$queryRaw<
            { id: string; processedAt: Date | null }[]
          >`SELECT "id", "processedAt" FROM "WebhookEvent"
            WHERE "provider" = ${provider}::"PaymentProvider" AND "eventId" = ${event.eventId}
            FOR UPDATE`;
          const row = rows[0];
          if (row.processedAt) return null;
          const fx = newEffects();
          await this.apply(tx, provider, event, fx);
          await tx.webhookEvent.update({
            where: { id: row.id },
            data: { processedAt: new Date(), error: fx.error ?? null },
          });
          return fx;
        },
        { timeout: 30_000, maxWait: 10_000 },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.prisma.webhookEvent
        .update({
          where: { provider_eventId: { provider, eventId: event.eventId } },
          data: { error: message.slice(0, 500) },
        })
        .catch(() => undefined);
      throw error;
    }
    if (!effects) return { duplicate: true };
    await this.runEffects(effects);
    return { duplicate: false };
  }

  /** Lo que se guarda del evento: nunca el `client_secret` de Stripe. */
  private storable(event: GatewayEvent): Prisma.InputJsonValue {
    const copy = JSON.parse(JSON.stringify(event)) as {
      payment?: { clientSecret?: string };
    };
    if (copy.payment) delete copy.payment.clientSecret;
    return copy;
  }

  private async apply(
    tx: Tx,
    provider: PaymentProvider,
    event: GatewayEvent,
    fx: Effects,
  ): Promise<void> {
    if (event.kind === 'payment') {
      await this.applyPayment(tx, provider, event.payment, fx);
    }
    if (event.kind === 'refund') {
      await this.refundEvents.applyEvent(tx, provider, event.refund, fx);
    }
    if (event.kind === 'dispute') {
      await this.disputes.applyEvent(tx, provider, event.dispute, fx);
    }
  }

  // ------------------------------------------------------------- Pagos

  private async findPayment(
    tx: Tx,
    provider: PaymentProvider,
    gw: GatewayPayment,
  ): Promise<PaymentRow | null> {
    if (gw.providerRef) {
      const byRef = await tx.payment.findUnique({
        where: {
          provider_providerRef: { provider, providerRef: gw.providerRef },
        },
      });
      if (byRef) return byRef;
    }
    const id = gw.metadata.paymentId;
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) return null;
    const byId = await tx.payment.findUnique({ where: { id } });
    return byId && byId.provider === provider ? byId : null;
  }

  private async applyPayment(
    tx: Tx,
    provider: PaymentProvider,
    gw: GatewayPayment,
    fx: Effects,
  ): Promise<void> {
    const found = await this.findPayment(tx, provider, gw);
    if (!found) {
      fx.error = 'unknown_payment';
      return;
    }
    fx.paymentId = found.id;
    let payment = found;

    if (!payment.providerRef && gw.providerRef) {
      payment = await tx.payment.update({
        where: { id: payment.id },
        data: { providerRef: gw.providerRef },
      });
    }

    switch (gw.status) {
      case 'SUCCEEDED':
        await this.settle(tx, payment, gw, fx);
        if (gw.disputed) {
          // Culqi marca la disputa en el propio cargo; solo con el pago ya acreditado.
          const settled = await tx.payment.findUniqueOrThrow({
            where: { id: payment.id },
          });
          if (SETTLED.includes(settled.status)) {
            await this.disputes.ensureOpen(tx, settled, provider, fx);
          }
        }
        return;
      case 'FAILED': {
        // Condicionado al estado: un fallo atrasado nunca pisa un éxito.
        const code = gw.failureCode ?? 'payment_failed';
        const changed = await tx.payment.updateMany({
          where: { id: payment.id, status: { in: OPEN_PAYMENT } },
          data: { status: 'FAILED', failureCode: code },
        });
        if (changed.count > 0) {
          await this.audit.record(
            {
              action: 'payment.failed',
              entity: 'Payment',
              entityId: payment.id,
              before: { status: payment.status },
              after: { status: 'FAILED', failureCode: code },
            },
            tx,
          );
        }
        return;
      }
      case 'CANCELLED': {
        const changed = await tx.payment.updateMany({
          where: { id: payment.id, status: { in: OPEN_PAYMENT } },
          data: { status: 'CANCELLED' },
        });
        if (changed.count > 0) {
          await this.audit.record(
            {
              action: 'payment.cancelled',
              entity: 'Payment',
              entityId: payment.id,
              before: { status: payment.status },
              after: { status: 'CANCELLED' },
            },
            tx,
          );
        }
        return;
      }
      case 'REQUIRES_ACTION':
        await tx.payment.updateMany({
          where: { id: payment.id, status: 'PENDING' },
          data: { status: 'REQUIRES_ACTION' },
        });
        return;
      default:
        return; // PENDING: nada que cambiar
    }
  }

  /** Acredita un cobro exitoso. */
  private async settle(
    tx: Tx,
    seen: PaymentRow,
    gw: GatewayPayment,
    fx: Effects,
  ): Promise<void> {
    // La reserva se bloquea ANTES de decidir y el pago se vuelve a leer: dos
    // eventos distintos del mismo cobro (ids de evento diferentes) se
    // serializan aquí y el segundo ve el pago ya acreditado.
    await tx.$queryRaw`SELECT "id" FROM "Booking" WHERE "id" = ${seen.bookingId} FOR UPDATE`;
    const payment = await tx.payment.findUniqueOrThrow({
      where: { id: seen.id },
    });
    if (SETTLED.includes(payment.status)) return;

    if (
      gw.amountCents !== payment.amountCents ||
      gw.currency !== payment.currency
    ) {
      // La pasarela cobró algo distinto de lo que pedimos: no se acredita a la reserva.
      await tx.payment.update({
        where: { id: payment.id },
        data: { status: 'FAILED', failureCode: 'amount_mismatch' },
      });
      await this.audit.record(
        {
          action: 'payment.mismatch',
          entity: 'Payment',
          entityId: payment.id,
          before: {
            amountCents: payment.amountCents,
            currency: payment.currency,
          },
          after: { amountCents: gw.amountCents, currency: gw.currency },
        },
        tx,
      );
      fx.error = 'amount_mismatch';
      fx.alerts.push({
        code: 'payment_amount_mismatch',
        data: {
          paymentId: payment.id,
          expected: `${payment.amountCents} ${payment.currency}`,
          received: `${gw.amountCents} ${gw.currency}`,
          providerRef: gw.providerRef,
        },
        bookingId: payment.bookingId,
      });
      return;
    }

    fx.settledPaymentId = payment.id;
    const booking = await tx.booking.findUniqueOrThrow({
      where: { id: payment.bookingId },
      include: { departure: true },
    });
    await tx.payment.update({
      where: { id: payment.id },
      data: {
        status: 'SUCCEEDED',
        paidAt: new Date(),
        failureCode: null,
        ...(gw.method ? { method: gw.method } : {}),
      },
    });
    if (payment.paymentLinkId) {
      await tx.paymentLink.updateMany({
        where: { id: payment.paymentLinkId, usedAt: null },
        data: { usedAt: new Date() },
      });
    }

    let status = booking.status;
    let reactivated = false;
    if (status !== 'PENDING_PAYMENT' && status !== 'CONFIRMED') {
      reactivated = await this.tryReactivate(tx, booking, fx);
      if (reactivated) status = 'PENDING_PAYMENT';
    }

    const before = {
      bookingStatus: booking.status,
      paidCents: booking.paidCents,
    };
    if (status === 'PENDING_PAYMENT' || status === 'CONFIRMED') {
      const pending = pendingCents(
        booking.totalCents,
        booking.paidCents,
        booking.refundedCents,
      );
      const applied = await this.bookingPayments.applySucceededPayment(
        tx,
        { ...booking, status },
        payment.amountCents,
      );
      if (applied.confirmed) fx.confirmedBookingId = booking.id;
      const excess = Math.max(0, payment.amountCents - pending);
      if (excess > 0) {
        await this.autoRefund(tx, payment, excess, 'overpayment', fx);
        fx.alerts.push({
          code: 'payment_overpaid',
          data: { paymentId: payment.id, excessCents: excess },
          bookingId: booking.id,
        });
      }
      await this.audit.record(
        {
          action: 'payment.succeeded',
          entity: 'Payment',
          entityId: payment.id,
          before,
          after: {
            bookingId: booking.id,
            amountCents: payment.amountCents,
            currency: payment.currency,
            bookingStatus: applied.confirmed ? 'CONFIRMED' : status,
            paidCents: applied.paidCents,
            reactivated,
          },
        },
        tx,
      );
      return;
    }

    // Reserva cancelada que no se puede reactivar: el dinero llegó, se devuelve.
    await tx.booking.update({
      where: { id: booking.id },
      data: { paidCents: { increment: payment.amountCents } },
    });
    await this.autoRefund(
      tx,
      payment,
      payment.amountCents,
      `late_payment:${booking.status.toLowerCase()}`,
      fx,
    );
    await this.audit.record(
      {
        action: 'payment.late',
        entity: 'Payment',
        entityId: payment.id,
        before,
        after: {
          bookingId: booking.id,
          bookingStatus: booking.status,
          amountCents: payment.amountCents,
          outcome: 'refund_queued',
        },
      },
      tx,
    );
    fx.alerts.push({
      code: 'payment_after_cancellation',
      data: {
        paymentId: payment.id,
        bookingReference: booking.reference,
        bookingStatus: booking.status,
        amountCents: payment.amountCents,
        currency: payment.currency,
        outcome: 'refunded_automatically',
      },
      bookingId: booking.id,
    });
  }

  /**
   * Un pago confirmado sobre una reserva que venció por falta de pago: se
   * reactiva si la salida sigue abierta y hay cupo (bajo candado de la salida).
   * Una reserva cancelada por una persona nunca se reactiva.
   */
  private async tryReactivate(
    tx: Tx,
    booking: Prisma.BookingGetPayload<{ include: { departure: true } }>,
    fx: Effects,
  ): Promise<boolean> {
    if (
      booking.status !== 'CANCELLED' ||
      booking.cancelReason !== 'payment_timeout'
    ) {
      return false;
    }
    const departure = booking.departure;
    const salesCloseAt =
      departure.startsAt.getTime() - departure.cutoffMinutes * 60_000;
    if (departure.status !== 'OPEN' || salesCloseAt <= Date.now()) return false;
    if (!(await this.seats.lockDeparture(tx, departure.id))) return false;
    const counts = (
      await this.seats.countFor([departure.id], new Date(), tx)
    ).get(departure.id)!;
    const people = booking.adults + booking.children;
    if (departure.capacity - counts.sold - counts.held < people) return false;

    await tx.booking.update({
      where: { id: booking.id },
      data: {
        status: 'PENDING_PAYMENT',
        cancelledAt: null,
        cancelReason: null,
      },
    });
    await this.audit.record(
      {
        action: 'booking.reactivate',
        entity: 'Booking',
        entityId: booking.id,
        before: { status: 'CANCELLED', reason: 'payment_timeout' },
        after: { status: 'PENDING_PAYMENT', reason: 'late_payment' },
      },
      tx,
    );
    fx.alerts.push({
      code: 'payment_reactivated_booking',
      data: { bookingReference: booking.reference },
      bookingId: booking.id,
    });
    return true;
  }

  private async autoRefund(
    tx: Tx,
    payment: PaymentRow,
    amountCents: number,
    reason: string,
    fx: Effects,
  ): Promise<void> {
    const refund = await tx.refund.create({
      data: {
        paymentId: payment.id,
        amountCents,
        reason,
        status: 'PENDING',
        policyTier: { mode: 'AUTO', reason },
      },
    });
    await this.audit.record(
      {
        action: 'refund.create',
        entity: 'Refund',
        entityId: refund.id,
        after: { paymentId: payment.id, amountCents, reason, auto: true },
      },
      tx,
    );
    fx.refundIds.push(refund.id);
  }

  private async runEffects(fx: Effects): Promise<void> {
    if (fx.confirmedBookingId) {
      try {
        await this.bookingPayments.sendConfirmedEmail(fx.confirmedBookingId);
      } catch (error) {
        this.logger.error(`Confirmation email failed: ${String(error)}`);
      }
    }
    for (const alert of fx.alerts) {
      await this.alerts.alert(alert.code, alert.data, {
        bookingId: alert.bookingId,
      });
    }
    for (const id of fx.refundIds) await this.refunds.execute(id);
    if (fx.settledPaymentId) {
      try {
        await this.documents.autoIssueForPayment(fx.settledPaymentId);
      } catch (error) {
        this.logger.error(`Auto-issue failed: ${String(error)}`);
      }
    }
  }
}
