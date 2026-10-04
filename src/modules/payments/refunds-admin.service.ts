import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  Paginated,
  PaginationQuery,
  paginated,
  skipTake,
} from '../../common/pagination/pagination';
import { IdempotencyService } from '../../common/idempotency/idempotency.service';
import { Prisma } from '../../generated/prisma/client';
import type { PaymentProvider } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../auth/auth.types';
import { SettingsService } from '../settings/settings.service';
import { CreateRefundDto } from './dto/admin.dto';
import type { Effects } from './payment-events.service';
import { REFUND_INCLUDE, toRefundDto } from './payments.mappers';
import type { GatewayRefund } from './providers/payment-gateway';
import { RefundsExecutor } from './refunds.service';

type Tx = Prisma.TransactionClient;

/**
 * Reembolsos desde el backoffice y desde los webhooks de las pasarelas.
 * Las filas `Refund` en `PENDING` que dejan la cancelación y la
 * reprogramación las ejecuta `RefundSweeper`.
 */
@Injectable()
export class RefundsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly executor: RefundsExecutor,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
    private readonly settings: SettingsService,
  ) {}

  private async emails(ids: (string | null)[]): Promise<Map<string, string>> {
    const wanted = [...new Set(ids.filter((id): id is string => !!id))];
    const users = wanted.length
      ? await this.prisma.user.findMany({
          where: { id: { in: wanted } },
          select: { id: true, email: true },
        })
      : [];
    return new Map(users.map((u) => [u.id, u.email]));
  }

  async list(q: PaginationQuery) {
    const [rows, total] = await Promise.all([
      this.prisma.refund.findMany({
        orderBy: { createdAt: 'desc' },
        include: REFUND_INCLUDE,
        ...skipTake(q),
      }),
      this.prisma.refund.count(),
    ]);
    const emails = await this.emails(rows.map((r) => r.requestedByUserId));
    return paginated(
      rows.map((r) =>
        toRefundDto(r, emails.get(r.requestedByUserId ?? '') ?? null),
      ),
      q,
      total,
    ) satisfies Paginated<unknown>;
  }

  async get(id: string) {
    const row = await this.prisma.refund.findUnique({
      where: { id },
      include: REFUND_INCLUDE,
    });
    if (!row) throw new NotFoundException('Refund not found');
    const emails = await this.emails([row.requestedByUserId]);
    return toRefundDto(row, emails.get(row.requestedByUserId ?? '') ?? null);
  }

  // ------------------------------------------------------------- Crear

  async create(
    paymentId: string,
    dto: CreateRefundDto,
    actor: AuthUser,
    ctx: { ip?: string; idempotencyKey?: string },
  ) {
    const head = await this.prisma.payment.findUnique({
      where: { id: paymentId },
      select: { bookingId: true },
    });
    if (!head) throw new NotFoundException('Payment not found');
    const limit = await this.settings.getNumber('operatorRefundLimitCents');

    const result = await this.idempotency.run(
      {
        scope: `createRefund:${paymentId}:${actor.id}`,
        key: ctx.idempotencyKey,
        request: dto,
      },
      async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "Booking" WHERE "id" = ${head.bookingId} FOR UPDATE`;
        const payment = await tx.payment.findUniqueOrThrow({
          where: { id: paymentId },
          include: { booking: true },
        });
        if (
          payment.status !== 'SUCCEEDED' &&
          payment.status !== 'PARTIALLY_REFUNDED'
        ) {
          throw new ConflictException(
            `A ${payment.status} payment cannot be refunded`,
          );
        }
        const pending = await tx.refund.aggregate({
          where: { paymentId, status: 'PENDING' },
          _sum: { amountCents: true },
        });
        const refundable =
          payment.amountCents -
          payment.refundedCents -
          (pending._sum.amountCents ?? 0);
        if (dto.amountCents > refundable) {
          throw new ConflictException({
            message: 'The amount exceeds what is refundable',
            details: { refundableCents: Math.max(0, refundable) },
          });
        }
        // El tope cuenta lo ya devuelto de toda la reserva y lo pendiente:
        // partir un reembolso grande en varios no lo evita.
        const bookingPending = await tx.refund.aggregate({
          where: { payment: { bookingId: head.bookingId }, status: 'PENDING' },
          _sum: { amountCents: true },
        });
        const outCents =
          payment.booking.refundedCents +
          (bookingPending._sum.amountCents ?? 0) +
          dto.amountCents;
        const aboveLimit = outCents > limit;
        if (aboveLimit && !actor.permissions.has('payments:refund-any')) {
          throw new ForbiddenException({
            message: 'The refund exceeds the operator limit',
            details: { operatorRefundLimitCents: limit },
          });
        }

        const refund = await tx.refund.create({
          data: {
            paymentId,
            amountCents: dto.amountCents,
            reason: dto.reason,
            status: 'PENDING',
            policyTier: { mode: 'MANUAL' },
            requestedByUserId: actor.id,
            approvedByUserId: aboveLimit ? actor.id : null,
          },
        });
        await this.audit.record(
          {
            actorUserId: actor.id,
            action: 'refund.create',
            entity: 'Refund',
            entityId: refund.id,
            after: {
              paymentId,
              amountCents: dto.amountCents,
              currency: payment.currency,
              provider: payment.provider,
              reason: dto.reason,
              aboveOperatorLimit: aboveLimit,
            },
            ip: ctx.ip,
          },
          tx,
        );
        if (payment.provider === 'MANUAL') {
          // El dinero lo devuelve el staff por su cuenta: queda registrado ya.
          await this.settleManual(tx, refund.id, actor.id, ctx.ip);
        }
        return { status: 201, body: { refundId: refund.id } };
      },
    );

    if (!result.replayed) await this.executor.execute(result.body.refundId);
    return {
      status: result.status,
      body: await this.get(result.body.refundId),
    };
  }

  /** Confirma un reembolso manual `PENDING` (el staff ya devolvió el dinero). */
  async complete(id: string, actor: AuthUser, ip?: string) {
    const head = await this.prisma.refund.findUnique({
      where: { id },
      include: { payment: { select: { bookingId: true } } },
    });
    if (!head) throw new NotFoundException('Refund not found');
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Booking" WHERE "id" = ${head.payment.bookingId} FOR UPDATE`;
      const refund = await tx.refund.findUniqueOrThrow({
        where: { id },
        include: { payment: true },
      });
      if (refund.status !== 'PENDING') {
        throw new ConflictException(`The refund is already ${refund.status}`);
      }
      if (refund.payment.provider !== 'MANUAL') {
        throw new ConflictException(
          'Gateway refunds are executed by the API, not confirmed by hand',
        );
      }
      await this.settleManual(tx, id, actor.id, ip);
    });
    return this.get(id);
  }

  private async settleManual(
    tx: Tx,
    refundId: string,
    actorId: string,
    ip?: string,
  ): Promise<void> {
    const refund = await tx.refund.update({
      where: { id: refundId },
      data: { status: 'SUCCEEDED', approvedByUserId: actorId },
    });
    await this.executor.applySucceeded(tx, refund);
    await this.audit.record(
      {
        actorUserId: actorId,
        action: 'refund.manual',
        entity: 'Refund',
        entityId: refundId,
        before: { status: 'PENDING' },
        after: {
          status: 'SUCCEEDED',
          paymentId: refund.paymentId,
          amountCents: refund.amountCents,
        },
        ip,
      },
      tx,
    );
  }

  // ----------------------------------------------------------- Webhooks

  /**
   * Evento de reembolso de la pasarela: cierra los que ejecutamos nosotros y
   * registra los hechos desde el panel de la pasarela. La reserva se bloquea
   * antes de tocar importes.
   */
  async applyEvent(
    tx: Tx,
    provider: PaymentProvider,
    gw: GatewayRefund,
    fx: Effects,
  ): Promise<void> {
    let refund = await tx.refund.findFirst({
      where: { providerRef: gw.providerRef, payment: { provider } },
      include: { payment: true },
    });
    const payment = refund
      ? refund.payment
      : await tx.payment.findUnique({
          where: {
            provider_providerRef: {
              provider,
              providerRef: gw.paymentProviderRef,
            },
          },
        });
    if (!payment) {
      fx.error = 'unknown_payment';
      return;
    }
    await tx.$queryRaw`SELECT "id" FROM "Booking" WHERE "id" = ${payment.bookingId} FOR UPDATE`;

    if (!refund) {
      // Hecho desde el panel de la pasarela: no hay fila nuestra.
      if (gw.status === 'PENDING') return;
      const created = await tx.refund.create({
        data: {
          paymentId: payment.id,
          amountCents: gw.amountCents,
          reason: 'external',
          status: gw.status,
          providerRef: gw.providerRef,
          policyTier: { mode: 'EXTERNAL' },
        },
      });
      refund = { ...created, payment };
      if (gw.status === 'SUCCEEDED') {
        await this.executor.applySucceeded(tx, created);
      }
      await this.audit.record(
        {
          action: 'refund.external',
          entity: 'Refund',
          entityId: created.id,
          after: {
            paymentId: payment.id,
            amountCents: gw.amountCents,
            status: gw.status,
          },
        },
        tx,
      );
      fx.alerts.push({
        code: 'refund_external',
        data: { paymentId: payment.id, amountCents: gw.amountCents },
        bookingId: payment.bookingId,
      });
      return;
    }

    const current = refund.status;
    if (gw.status === 'SUCCEEDED' && current !== 'SUCCEEDED') {
      await tx.refund.update({
        where: { id: refund.id },
        data: { status: 'SUCCEEDED', providerRef: gw.providerRef },
      });
      await this.executor.applySucceeded(tx, refund);
      await this.audit.record(
        {
          action: 'refund.succeeded',
          entity: 'Refund',
          entityId: refund.id,
          before: { status: current },
          after: { status: 'SUCCEEDED', amountCents: refund.amountCents },
        },
        tx,
      );
    } else if (gw.status === 'FAILED' && current !== 'FAILED') {
      await tx.refund.update({
        where: { id: refund.id },
        data: { status: 'FAILED' },
      });
      if (current === 'SUCCEEDED') await this.reverse(tx, refund);
      await this.audit.record(
        {
          action: 'refund.failed',
          entity: 'Refund',
          entityId: refund.id,
          before: { status: current },
          after: { status: 'FAILED', code: gw.failureCode ?? null },
        },
        tx,
      );
      fx.alerts.push({
        code: current === 'SUCCEEDED' ? 'refund_reversed' : 'refund_failed',
        data: { refundId: refund.id, paymentId: payment.id },
        bookingId: payment.bookingId,
      });
    }
    // PENDING sobre un reembolso ya resuelto: evento atrasado, no cambia nada.
  }

  /** Un reembolso que ya contamos como exitoso fracasó después: se descuenta. */
  private async reverse(
    tx: Tx,
    refund: { paymentId: string; amountCents: number },
  ): Promise<void> {
    const payment = await tx.payment.findUniqueOrThrow({
      where: { id: refund.paymentId },
    });
    const refundedCents = Math.max(
      0,
      payment.refundedCents - refund.amountCents,
    );
    await tx.payment.update({
      where: { id: payment.id },
      data: {
        refundedCents,
        status:
          payment.status === 'DISPUTED'
            ? 'DISPUTED'
            : refundedCents === 0
              ? 'SUCCEEDED'
              : 'PARTIALLY_REFUNDED',
      },
    });
    await tx.booking.update({
      where: { id: payment.bookingId },
      data: { refundedCents: { decrement: refund.amountCents } },
    });
  }
}
