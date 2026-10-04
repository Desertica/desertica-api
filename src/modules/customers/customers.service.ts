import { Injectable, NotFoundException } from '@nestjs/common';
import { paginated, skipTake } from '../../common/pagination/pagination';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { normalizeEmail } from '../bookings/booking-support';
import { toBookingSummary, toCustomerDto } from '../bookings/booking.mappers';
import { CustomerQuery, UpdateCustomerDto } from '../bookings/dto/booking.dto';

@Injectable()
export class CustomersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(q: CustomerQuery) {
    const search = q.q?.trim();
    const where: Prisma.CustomerWhereInput = search
      ? {
          OR: [
            { email: { contains: search, mode: 'insensitive' } },
            { firstName: { contains: search, mode: 'insensitive' } },
            { lastName: { contains: search, mode: 'insensitive' } },
            { phone: { contains: search } },
            { idDocNumber: { contains: search } },
          ],
        }
      : {};
    const [rows, total] = await Promise.all([
      this.prisma.customer.findMany({
        where,
        orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
        ...skipTake(q),
      }),
      this.prisma.customer.count({ where }),
    ]);
    return paginated(rows.map(toCustomerDto), q, total);
  }

  async get(id: string) {
    const customer = await this.prisma.customer.findUnique({
      where: { id },
      include: {
        bookings: {
          orderBy: { createdAt: 'desc' },
          include: {
            customer: true,
            departure: { include: { tourRef: { select: { slug: true } } } },
          },
        },
      },
    });
    if (!customer) throw new NotFoundException('Customer not found');
    return {
      ...toCustomerDto(customer),
      bookings: customer.bookings.map(toBookingSummary),
    };
  }

  async update(
    id: string,
    dto: UpdateCustomerDto,
    actorId: string,
    ip?: string,
  ) {
    const before = await this.prisma.customer.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('Customer not found');
    await this.prisma.$transaction(async (tx) => {
      const updated = await tx.customer.update({
        where: { id },
        data: {
          email: normalizeEmail(dto.email),
          firstName: dto.firstName.trim(),
          lastName: dto.lastName.trim(),
          phone: dto.phone ?? null,
          country: dto.country?.toUpperCase() ?? null,
          idDocType: dto.idDocType ?? null,
          idDocNumber: dto.idDocNumber ?? null,
          ...(dto.locale ? { locale: dto.locale } : {}),
        },
      });
      await this.audit.record(
        {
          actorUserId: actorId,
          action: 'customer.update',
          entity: 'Customer',
          entityId: id,
          before: toCustomerDto(before),
          after: toCustomerDto(updated),
          ip,
        },
        tx,
      );
    });
    return this.get(id);
  }
}
