import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { paginated, skipTake } from '../../common/pagination/pagination';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { TourTitlesService } from '../cms/tour-titles.service';
import { normalizeEmail } from '../bookings/booking-support';
import { toBookingSummary, toCustomerDto } from '../bookings/booking.mappers';
import { CustomerQuery, UpdateCustomerDto } from '../bookings/dto/booking.dto';

/** Valor con que se reemplazan los nombres al anonimizar. */
const ERASED = 'Anonimizado';

@Injectable()
export class CustomersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly titles: TourTitlesService,
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
            departure: {
              include: { tourRef: { select: { slug: true, title: true } } },
            },
          },
        },
      },
    });
    if (!customer) throw new NotFoundException('Customer not found');
    const titles = await this.titles.forTours(
      customer.bookings.map((b) => b.departure.tourRef),
    );
    return {
      ...toCustomerDto(customer),
      bookings: customer.bookings.map((b) => toBookingSummary(b, titles)),
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
          // Solo los nombres de los campos: la auditoría es inmutable y no debe guardar datos personales.
          after: {
            changed: (
              Object.keys(toCustomerDto(updated)) as (keyof ReturnType<
                typeof toCustomerDto
              >)[]
            ).filter(
              (k) => toCustomerDto(before)[k] !== toCustomerDto(updated)[k],
            ),
          },
          ip,
        },
        tx,
      );
    });
    return this.get(id);
  }

  /**
   * Pedido ARCO de eliminación. Anonimiza al cliente y los datos personales de
   * sus reservas; conserva lo que la ley obliga a guardar (comprobantes con su
   * receptor y reclamos). La auditoría es inmutable: solo recibe conteos.
   * Idempotente. Se niega (409) si todavía hay que operar con esos datos.
   */
  async erase(id: string, actorId: string, ip?: string, now = new Date()) {
    await this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "Customer" WHERE "id" = ${id} FOR UPDATE`;
      if (locked.length === 0)
        throw new NotFoundException('Customer not found');
      const customer = await tx.customer.findUniqueOrThrow({ where: { id } });
      if (customer.erasedAt) return;
      // Congela las reservas del cliente: un pago simultáneo no cambia su estado a medias.
      await tx.$queryRaw`
        SELECT "id" FROM "Booking" WHERE "customerId" = ${id} FOR UPDATE`;

      const bookings = await tx.booking.findMany({
        where: { customerId: id },
        select: {
          id: true,
          reference: true,
          status: true,
          billing: true,
          departure: { select: { startsAt: true } },
          _count: { select: { documents: true } },
        },
      });
      const ids = bookings.map((b) => b.id);
      const upcoming = bookings.filter(
        (b) =>
          (b.status === 'PENDING_PAYMENT' || b.status === 'CONFIRMED') &&
          b.departure.startsAt > now,
      );
      const [pendingRefunds, openDisputes] = await Promise.all([
        tx.refund.count({
          where: { status: 'PENDING', payment: { bookingId: { in: ids } } },
        }),
        tx.dispute.count({
          where: { status: 'OPEN', payment: { bookingId: { in: ids } } },
        }),
      ]);
      if (upcoming.length + pendingRefunds + openDisputes > 0) {
        throw new ConflictException({
          message:
            'The customer still has upcoming bookings, pending refunds or open disputes',
          details: {
            upcomingBookings: upcoming.length,
            pendingRefunds,
            openDisputes,
          },
        });
      }

      const ofCustomer = { booking: { customerId: id } };
      const passengers = await tx.passenger.updateMany({
        where: ofCustomer,
        data: {
          firstName: ERASED,
          lastName: ERASED,
          idDocType: null,
          idDocNumber: null,
          birthDate: null,
          nationality: null,
          emergencyContactName: null,
          emergencyContactPhone: null,
        },
      });
      const waiverCommon = {
        signerDocType: null,
        signerDocNumber: null,
        medicalNotes: null,
        ip: null,
        pdfKey: null,
      };
      await tx.waiver.updateMany({
        where: { ...ofCustomer, status: 'SIGNED' },
        data: { ...waiverCommon, signerName: ERASED },
      });
      await tx.waiver.updateMany({
        where: { ...ofCustomer, status: 'PENDING' },
        data: { ...waiverCommon, signerName: null },
      });
      for (const b of bookings) {
        // El receptor de un comprobante emitido se conserva por obligación tributaria.
        const keepBilling = b._count.documents > 0;
        const docType = (b.billing as { docType?: string } | null)?.docType;
        await tx.booking.update({
          where: { id: b.id },
          data: {
            notes: null,
            cancelReason: null,
            anonymousId: null,
            attribution: Prisma.DbNull,
            ...(keepBilling
              ? {}
              : { billing: { docType: docType ?? 'BOLETA', erased: true } }),
          },
        });
      }
      await tx.refund.updateMany({
        where: { payment: { bookingId: { in: ids } } },
        data: { reason: 'erased' },
      });
      await tx.payment.updateMany({
        where: { bookingId: { in: ids } },
        data: { providerPayload: Prisma.DbNull },
      });
      await tx.notification.updateMany({
        where: {
          OR: [{ bookingId: { in: ids } }, { toAddress: customer.email }],
        },
        data: { toAddress: 'erased' },
      });
      await tx.bookingAccessToken.deleteMany({
        where: { bookingId: { in: ids } },
      });
      await tx.acceptance.updateMany({
        where: { OR: [{ customerId: id }, { bookingId: { in: ids } }] },
        data: { ip: null, userAgent: null },
      });
      await tx.contactMessage.deleteMany({
        where: { email: { equals: customer.email, mode: 'insensitive' } },
      });
      // Respuestas idempotentes guardadas: la de una reserva manual trae la reserva completa.
      await tx.idempotencyRecord.deleteMany({
        where: {
          OR: [
            ...ids.map((bid) => ({ body: { path: ['id'], equals: bid } })),
            ...bookings.map((b) => ({
              body: { path: ['reference'], equals: b.reference },
            })),
          ],
        },
      });
      await tx.customer.update({
        where: { id },
        data: {
          email: `erased-${id}@erased.invalid`,
          firstName: ERASED,
          lastName: ERASED,
          phone: null,
          country: null,
          idDocType: null,
          idDocNumber: null,
          erasedAt: now,
        },
      });
      await this.audit.record(
        {
          actorUserId: actorId,
          action: 'customer.erase',
          entity: 'Customer',
          entityId: id,
          after: { bookings: bookings.length, passengers: passengers.count },
          ip,
        },
        tx,
      );
    });
  }
}
