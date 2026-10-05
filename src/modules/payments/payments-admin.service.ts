import { Injectable, NotFoundException } from '@nestjs/common';
import { paginated, skipTake } from '../../common/pagination/pagination';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { PaymentsQuery } from './dto/admin.dto';
import { toPaymentDto } from './payments.mappers';

const WITH_BOOKING = {
  booking: { select: { reference: true } },
} as const;

/** Lectura de pagos para el backoffice. */
@Injectable()
export class PaymentsAdminService {
  constructor(private readonly prisma: PrismaService) {}

  async list(q: PaymentsQuery) {
    const where: Prisma.PaymentWhereInput = {
      ...(q.status ? { status: q.status } : {}),
      ...(q.provider ? { provider: q.provider } : {}),
      ...(q.from || q.to
        ? {
            createdAt: {
              ...(q.from ? { gte: new Date(q.from) } : {}),
              ...(q.to ? { lte: new Date(q.to) } : {}),
            },
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.payment.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        include: WITH_BOOKING,
        ...skipTake(q),
      }),
      this.prisma.payment.count({ where }),
    ]);
    return paginated(
      rows.map((p) => toPaymentDto(p, p.booking.reference)),
      q,
      total,
    );
  }

  async get(id: string) {
    const row = await this.prisma.payment.findUnique({
      where: { id },
      include: WITH_BOOKING,
    });
    if (!row) throw new NotFoundException('Payment not found');
    return toPaymentDto(row, row.booking.reference);
  }
}
