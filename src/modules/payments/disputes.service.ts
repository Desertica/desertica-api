import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  PaginationQuery,
  paginated,
  skipTake,
} from '../../common/pagination/pagination';
import { Prisma } from '../../generated/prisma/client';
import type {
  DisputeStatus,
  PaymentProvider,
} from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../auth/auth.types';
import { UpdateDisputeDto } from './dto/admin.dto';
import { SETTLED, type Effects } from './payment-state';
import { REFUND_INCLUDE, toDisputeDto } from './payments.mappers';
import type { GatewayDispute } from './providers/payment-gateway';

type Tx = Prisma.TransactionClient;

const TERMINAL: DisputeStatus[] = ['WON', 'LOST', 'CLOSED'];

/** Estado del pago mientras no hay una disputa abierta. */
const restingStatus = (p: { refundedCents: number }) =>
  p.refundedCents > 0 ? 'PARTIALLY_REFUNDED' : 'SUCCEEDED';

/** Disputas y contracargos: lectura, edición del staff y eventos de la pasarela. */
@Injectable()
export class DisputesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(q: PaginationQuery & { status?: DisputeStatus }) {
    const where: Prisma.DisputeWhereInput = q.status
      ? { status: q.status }
      : {};
    const [rows, total] = await Promise.all([
      this.prisma.dispute.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        include: REFUND_INCLUDE,
        ...skipTake(q),
      }),
      this.prisma.dispute.count({ where }),
    ]);
    return paginated(rows.map(toDisputeDto), q, total);
  }

  async get(id: string) {
    const row = await this.prisma.dispute.findUnique({
      where: { id },
      include: REFUND_INCLUDE,
    });
    if (!row) throw new NotFoundException('Dispute not found');
    return toDisputeDto(row);
  }

  async update(
    id: string,
    dto: UpdateDisputeDto,
    actor: AuthUser,
    ip?: string,
  ) {
    const head = await this.prisma.dispute.findUnique({
      where: { id },
      include: { payment: { select: { bookingId: true } } },
    });
    if (!head) throw new NotFoundException('Dispute not found');
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Booking" WHERE "id" = ${head.payment.bookingId} FOR UPDATE`;
      const dispute = await tx.dispute.findUniqueOrThrow({ where: { id } });
      if (
        dto.status &&
        dto.status !== dispute.status &&
        TERMINAL.includes(dispute.status) &&
        !TERMINAL.includes(dto.status)
      ) {
        throw new ConflictException(
          `A ${dispute.status} dispute cannot be reopened`,
        );
      }
      await tx.dispute.update({
        where: { id },
        data: {
          ...(dto.status ? { status: dto.status } : {}),
          ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
        },
      });
      if (dto.status && dto.status !== dispute.status) {
        await this.syncPaymentStatus(tx, dispute.paymentId, dto.status);
      }
      await this.audit.record(
        {
          actorUserId: actor.id,
          action: 'dispute.update',
          entity: 'Dispute',
          entityId: id,
          before: { status: dispute.status },
          // Las notas pueden traer datos personales: solo se audita que cambiaron.
          after: {
            status: dto.status ?? dispute.status,
            notesChanged: dto.notes !== undefined,
          },
          ip,
        },
        tx,
      );
    });
    return this.get(id);
  }

  /** Disputa abierta o perdida: el pago queda `DISPUTED`; ganada o cerrada: vuelve a su estado. */
  private async syncPaymentStatus(
    tx: Tx,
    paymentId: string,
    status: DisputeStatus,
  ): Promise<void> {
    const payment = await tx.payment.findUniqueOrThrow({
      where: { id: paymentId },
    });
    if (status === 'OPEN' || status === 'LOST') {
      if (
        payment.status === 'SUCCEEDED' ||
        payment.status === 'PARTIALLY_REFUNDED'
      ) {
        await tx.payment.update({
          where: { id: paymentId },
          data: { status: 'DISPUTED' },
        });
      }
    } else if (payment.status === 'DISPUTED') {
      await tx.payment.update({
        where: { id: paymentId },
        data: { status: restingStatus(payment) },
      });
    }
  }

  /** Evento de disputa de la pasarela: crea o actualiza y avisa al staff. */
  async applyEvent(
    tx: Tx,
    provider: PaymentProvider,
    gw: GatewayDispute,
    fx: Effects,
  ): Promise<void> {
    const payment = await tx.payment.findUnique({
      where: {
        provider_providerRef: { provider, providerRef: gw.paymentProviderRef },
      },
    });
    if (!payment) {
      fx.error = 'unknown_payment';
      return;
    }
    await this.upsert(tx, payment, provider, gw, fx);
  }

  /** Culqi marca la disputa en el propio cargo: se abre una si todavía no existe. */
  async ensureOpen(
    tx: Tx,
    payment: Prisma.PaymentGetPayload<object>,
    provider: PaymentProvider,
    fx: Effects,
  ): Promise<void> {
    if (!payment.providerRef) return;
    await this.upsert(
      tx,
      payment,
      provider,
      {
        providerRef: payment.providerRef,
        paymentProviderRef: payment.providerRef,
        status: 'OPEN',
        reason: null,
        amountCents: payment.amountCents,
        currency: payment.currency,
        evidenceDueAt: null,
      },
      fx,
      { createOnly: true },
    );
  }

  private async upsert(
    tx: Tx,
    payment: Prisma.PaymentGetPayload<object>,
    provider: PaymentProvider,
    gw: GatewayDispute,
    fx: Effects,
    options: { createOnly?: boolean } = {},
  ): Promise<void> {
    await tx.$queryRaw`SELECT "id" FROM "Booking" WHERE "id" = ${payment.bookingId} FOR UPDATE`;
    const settled = await tx.payment.findUniqueOrThrow({
      where: { id: payment.id },
    });
    if (!SETTLED.includes(settled.status)) {
      // Evento fuera de orden: la disputa llegó antes que la confirmación del cobro.
      throw new ConflictException('The payment is not settled yet');
    }
    const existing = await tx.dispute.findUnique({
      where: {
        provider_providerRef: { provider, providerRef: gw.providerRef },
      },
    });
    if (!existing) {
      const created = await tx.dispute.create({
        data: {
          paymentId: payment.id,
          provider,
          providerRef: gw.providerRef,
          status: gw.status,
          reason: gw.reason,
          amountCents: gw.amountCents,
          currency: gw.currency,
          evidenceDueAt: gw.evidenceDueAt,
        },
      });
      await this.syncPaymentStatus(tx, payment.id, gw.status);
      await this.audit.record(
        {
          action: 'dispute.open',
          entity: 'Dispute',
          entityId: created.id,
          after: {
            paymentId: payment.id,
            provider,
            status: gw.status,
            amountCents: gw.amountCents,
            currency: gw.currency,
          },
        },
        tx,
      );
      fx.alerts.push({
        code: 'dispute_opened',
        data: {
          disputeId: created.id,
          paymentId: payment.id,
          amountCents: gw.amountCents,
          currency: gw.currency,
          evidenceDueAt: gw.evidenceDueAt?.toISOString() ?? null,
        },
        bookingId: payment.bookingId,
      });
      return;
    }
    if (options.createOnly) return;

    // Un evento atrasado no reabre una disputa que ya terminó.
    const status =
      TERMINAL.includes(existing.status) && !TERMINAL.includes(gw.status)
        ? existing.status
        : gw.status;
    await tx.dispute.update({
      where: { id: existing.id },
      data: {
        status,
        reason: gw.reason ?? existing.reason,
        amountCents: gw.amountCents,
        evidenceDueAt: gw.evidenceDueAt ?? existing.evidenceDueAt,
      },
    });
    if (status !== existing.status) {
      await this.syncPaymentStatus(tx, payment.id, status);
      await this.audit.record(
        {
          action: 'dispute.update',
          entity: 'Dispute',
          entityId: existing.id,
          before: { status: existing.status },
          after: { status },
        },
        tx,
      );
      if (status === 'LOST' || status === 'WON') {
        fx.alerts.push({
          code: status === 'LOST' ? 'dispute_lost' : 'dispute_won',
          data: { disputeId: existing.id, amountCents: gw.amountCents },
          bookingId: payment.bookingId,
        });
      }
    }
  }
}
