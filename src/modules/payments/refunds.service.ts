import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { GatewayRegistry } from './gateway.registry';
import {
  GatewayError,
  GatewayNotConfiguredError,
} from './providers/payment-gateway';
import { StaffAlertsService } from './staff-alerts.service';

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

            let result;
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
              if (
                error instanceof GatewayNotConfiguredError ||
                (code && TRANSIENT.has(code))
              ) {
                this.logger.warn(
                  `Refund ${refundId} will be retried: ${String(error)}`,
                );
                return 'retry';
              }
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
                  after: { status: 'FAILED', code: code ?? 'unknown' },
                },
                tx,
              );
              return 'failed';
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
          { timeout: 30_000, maxWait: 10_000 },
        )
        .then(async (outcome) => {
          if (outcome === 'failed') {
            await this.alerts.alert('refund_failed', {
              refundId,
              paymentId: head.paymentId,
              amountCents: head.amountCents,
            });
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
