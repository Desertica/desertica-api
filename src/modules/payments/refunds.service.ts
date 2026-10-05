import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { GatewayRegistry } from './gateway.registry';
import {
  GatewayError,
  GatewayNotConfiguredError,
  type GatewayRefund,
  type PaymentGateway,
} from './providers/payment-gateway';
import { StaffAlertsService } from '../alerts/staff-alerts.service';
import { DocumentsService } from '../documents/documents.service';

type Tx = Prisma.TransactionClient;

/** Errores que se reintentan en el siguiente barrido (el reembolso sigue `PENDING`). */
const TRANSIENT = new Set(['unreachable', 'bad_response']);

export type ExecuteOutcome =
  'succeeded' | 'failed' | 'retry' | 'skipped' | 'manual';

/**
 * Ejecuta filas `Refund` en `PENDING` contra la pasarela original y refleja el
 * resultado en el pago y la reserva (en una sola transacción con la auditoría).
 */
@Injectable()
export class RefundsExecutor {
  private readonly logger = new Logger(RefundsExecutor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gateways: GatewayRegistry,
    private readonly audit: AuditService,
    private readonly alerts: StaffAlertsService,
    private readonly documents: DocumentsService,
  ) {}

  /** Suma un reembolso exitoso a pago y reserva. La reserva debe estar bloqueada. */
  async applySucceeded(
    tx: Tx,
    refund: { id: string; paymentId: string; amountCents: number },
  ): Promise<void> {
    const payment = await tx.payment.findUniqueOrThrow({
      where: { id: refund.paymentId },
    });
    const refundedCents = payment.refundedCents + refund.amountCents;
    await tx.payment.update({
      where: { id: payment.id },
      data: {
        refundedCents,
        status:
          payment.status === 'DISPUTED'
            ? 'DISPUTED'
            : refundedCents >= payment.amountCents
              ? 'REFUNDED'
              : 'PARTIALLY_REFUNDED',
      },
    });
    await tx.booking.update({
      where: { id: payment.bookingId },
      data: { refundedCents: { increment: refund.amountCents } },
    });
    // Nota de crédito automática si el pago tenía comprobante (en la misma transacción).
    await this.documents.creditNoteForRefund(tx, refund);
  }

  /**
   * ¿Ya aplicó la pasarela este reembolso aunque no viéramos la respuesta?
   * `null` si no se puede saber (la pasarela no informa lo devuelto o no responde).
   */
  private async alreadyApplied(
    gateway: PaymentGateway,
    payment: { providerRef: string | null; refundedCents: number },
    amountCents: number,
  ): Promise<boolean | null> {
    try {
      const charge = await gateway.retrievePayment(payment.providerRef!);
      if (charge.refundedCents === undefined) return null;
      return charge.refundedCents >= payment.refundedCents + amountCents;
    } catch {
      return null;
    }
  }

  async execute(refundId: string): Promise<ExecuteOutcome> {
    const head = await this.prisma.refund.findUnique({
      where: { id: refundId },
      include: { payment: true },
    });
    if (!head || head.status !== 'PENDING') return 'skipped';
    const provider = head.payment.provider;
    if (provider === 'MANUAL') return 'manual';
    if (!head.payment.providerRef) return 'skipped';
    const gateway = this.gateways.get(provider);

    try {
      return await this.prisma
        .$transaction(
          async (tx) => {
            // Un solo ejecutor por reembolso; el candado se libera al terminar la transacción.
            const lock = await tx.$queryRaw<{ locked: boolean }[]>`
            SELECT pg_try_advisory_xact_lock(hashtext(${`refund:${refundId}`})) AS locked`;
            if (!lock[0]?.locked) return 'skipped';
            const current = await tx.refund.findUniqueOrThrow({
              where: { id: refundId },
            });
            if (current.status !== 'PENDING') return 'skipped';

            let result: GatewayRefund;
            try {
              result = await gateway.refund({
                refundId,
                paymentProviderRef: head.payment.providerRef!,
                amountCents: head.amountCents,
                currency: head.payment.currency,
                reason: head.reason,
              });
            } catch (error) {
              const code =
                error instanceof GatewayError ? error.code : undefined;
              const transient =
                error instanceof GatewayNotConfiguredError ||
                (code !== undefined && TRANSIENT.has(code));
              if (transient && error instanceof GatewayNotConfiguredError) {
                return 'retry'; // no se llegó a llamar a la pasarela
              }
              if (transient && provider === 'STRIPE') {
                // Stripe es idempotente por `refund:<id>`: reintentar es seguro.
                this.logger.warn(`Refund ${refundId} will be retried: ${code}`);
                return 'retry';
              }
              if (transient) {
                // Culqi (sin clave de idempotencia verificada): la llamada pudo
                // aplicarse aunque no se viera la respuesta. Antes de reintentar
                // se mira el cargo; si no se puede confirmar, no se reintenta a ciegas.
                const applied = await this.alreadyApplied(
                  gateway,
                  head.payment,
                  head.amountCents,
                );
                if (applied === false) {
                  this.logger.warn(
                    `Refund ${refundId} will be retried: ${code}`,
                  );
                  return 'retry';
                }
                if (applied === true) {
                  result = {
                    providerRef: `unconfirmed:${refundId}`,
                    paymentProviderRef: head.payment.providerRef!,
                    status: 'SUCCEEDED',
                    amountCents: head.amountCents,
                  };
                }
              }
              if (!result!) {
                await tx.refund.update({
                  where: { id: refundId },
                  data: { status: 'FAILED' },
                });
                await this.audit.record(
                  {
                    action: 'refund.failed',
                    entity: 'Refund',
                    entityId: refundId,
                    before: { status: 'PENDING' },
                    after: {
                      status: 'FAILED',
                      code: transient ? 'unconfirmed' : (code ?? 'unknown'),
                    },
                  },
                  tx,
                );
                return 'failed';
              }
            }

            if (result.status === 'FAILED') {
              await tx.refund.update({
                where: { id: refundId },
                data: { status: 'FAILED', providerRef: result.providerRef },
              });
              return 'failed';
            }
            await tx.$queryRaw`SELECT "id" FROM "Booking" WHERE "id" = ${head.payment.bookingId} FOR UPDATE`;
            if (result.status === 'SUCCEEDED') {
              await tx.refund.update({
                where: { id: refundId },
                data: { status: 'SUCCEEDED', providerRef: result.providerRef },
              });
              await this.applySucceeded(tx, head);
            } else {
              // Pendiente en la pasarela: el webhook `refund.updated` lo cierra.
              await tx.refund.update({
                where: { id: refundId },
                data: { providerRef: result.providerRef },
              });
            }
            await this.audit.record(
              {
                action: 'refund.execute',
                entity: 'Refund',
                entityId: refundId,
                before: { status: 'PENDING' },
                after: {
                  status: result.status,
                  paymentId: head.paymentId,
                  amountCents: head.amountCents,
                  providerRef: result.providerRef,
                },
              },
              tx,
            );
            return result.status === 'SUCCEEDED' ? 'succeeded' : 'skipped';
          },
          { timeout: 90_000, maxWait: 10_000 },
        )
        .then(async (outcome) => {
          if (outcome === 'failed') {
            await this.alerts.alert(
              'refund_failed',
              {
                refundId,
                paymentId: head.paymentId,
                amountCents: head.amountCents,
              },
              { bookingId: head.payment.bookingId },
            );
          }
          return outcome;
        });
    } catch (error) {
      this.logger.error(
        `Refund ${refundId} crashed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 'retry';
    }
  }
}
