import { Injectable, NotFoundException } from '@nestjs/common';
import { paginated, skipTake } from '../../common/pagination/pagination';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { TourTitlesService } from '../cms/tour-titles.service';
import {
  bookingPending,
  toBookingDto,
  toBookingSummary,
} from './booking.mappers';
import { BookingQuery, PaymentStatusFilter } from './dto/booking.dto';
import { paymentOptionsFor } from './payment-options';

type Db = PrismaService | Prisma.TransactionClient;

@Injectable()
export class BookingViewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly titles: TourTitlesService,
  ) {}

  readonly summaryInclude = {
    departure: {
      include: { tourRef: { select: { slug: true, title: true } } },
    },
    customer: true,
  } satisfies Prisma.BookingInclude;

  readonly fullInclude = {
    departure: {
      include: { tourRef: { select: { slug: true, title: true } } },
    },
    customer: true,
    passengers: { orderBy: { id: 'asc' as const } },
    payments: { orderBy: { createdAt: 'asc' as const } },
    documents: {
      include: { series: true },
      orderBy: { createdAt: 'asc' as const },
    },
    waivers: { orderBy: { createdAt: 'asc' as const } },
  } satisfies Prisma.BookingInclude;

  /** Compara lo cobrado con el total de la misma fila (referencias de campo de Prisma). */
  private paymentStatusWhere(
    status: PaymentStatusFilter | undefined,
  ): Prisma.BookingWhereInput {
    const total = this.prisma.booking.fields.totalCents;
    switch (status) {
      case 'UNPAID':
        return { paidCents: 0 };
      case 'PARTIAL':
        return { paidCents: { gt: 0, lt: total } };
      case 'PAID':
        return { paidCents: { gte: total } };
      default:
        return {};
    }
  }

  async list(q: BookingQuery) {
    const search = q.q?.trim();
    const where: Prisma.BookingWhereInput = {
      ...(q.status ? { status: q.status } : {}),
      ...(q.departureId ? { departureId: q.departureId } : {}),
      ...(q.source ? { source: q.source } : {}),
      ...(q.currency ? { currency: q.currency } : {}),
      ...(q.customerId ? { customerId: q.customerId } : {}),
      ...this.paymentStatusWhere(q.paymentStatus),
      ...(q.waiverStatus === 'PENDING'
        ? { waivers: { some: { status: 'PENDING' as const } } }
        : q.waiverStatus === 'SIGNED'
          ? {
              waivers: {
                some: {},
                none: { status: 'PENDING' as const },
              },
            }
          : {}),
      ...(q.tourRefId || q.from || q.to
        ? {
            departure: {
              ...(q.tourRefId ? { tourRefId: q.tourRefId } : {}),
              ...(q.from || q.to
                ? {
                    startsAt: {
                      ...(q.from ? { gte: new Date(q.from) } : {}),
                      ...(q.to ? { lt: new Date(q.to) } : {}),
                    },
                  }
                : {}),
            },
          }
        : {}),
      ...(search
        ? {
            OR: [
              { reference: { contains: search, mode: 'insensitive' } },
              {
                customer: { email: { contains: search, mode: 'insensitive' } },
              },
              {
                customer: {
                  firstName: { contains: search, mode: 'insensitive' },
                },
              },
              {
                customer: {
                  lastName: { contains: search, mode: 'insensitive' },
                },
              },
              { customer: { idDocNumber: { contains: search } } },
              { passengers: { some: { idDocNumber: { contains: search } } } },
            ],
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.booking.findMany({
        where,
        include: this.summaryInclude,
        orderBy: { createdAt: 'desc' },
        ...skipTake(q),
      }),
      this.prisma.booking.count({ where }),
    ]);
    const titles = await this.titles.forTours(
      rows.map((r) => r.departure.tourRef),
    );
    return paginated(
      rows.map((r) => toBookingSummary(r, titles)),
      q,
      total,
    );
  }

  async get(id: string, db: Db = this.prisma) {
    const row = await db.booking.findUnique({
      where: { id },
      include: this.fullInclude,
    });
    if (!row) throw new NotFoundException('Booking not found');
    const pending = await db.refund.aggregate({
      where: { status: 'PENDING', payment: { bookingId: id } },
      _sum: { amountCents: true },
    });
    return toBookingDto(row, {
      refundDueCents: pending._sum.amountCents ?? 0,
      titles: await this.titles.forTours([row.departure.tourRef]),
    });
  }

  toPublicById(bookingId: string) {
    return this.toPublic(this.prisma, bookingId);
  }

  /** Vista del cliente: sin datos internos (notas, snapshot de precio, auditoría). */
  async toPublic(db: Db, bookingId: string) {
    const b = await db.booking.findUnique({
      where: { id: bookingId },
      include: {
        departure: {
          include: { tourRef: { select: { slug: true, title: true } } },
        },
        passengers: { orderBy: { id: 'asc' } },
        waivers: {
          include: { passenger: true },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    if (!b) throw new NotFoundException('Booking not found');
    const snapshot = b.cancellationSnapshot as {
      tiers?: { hoursBefore: number; refundPercent: number }[];
    };
    return {
      reference: b.reference,
      status: b.status,
      tourSlug: b.departure.tourRef.slug,
      startsAt: b.departure.startsAt,
      format: b.departure.format,
      meetingPoint: b.departure.meetingPoint,
      adults: b.adults,
      children: b.children,
      currency: b.currency,
      totalCents: b.totalCents,
      paidCents: b.paidCents,
      pendingCents: bookingPending(b),
      depositCents: b.depositCents,
      passengers: b.passengers.map((p) => ({
        firstName: p.firstName,
        lastName: p.lastName,
      })),
      paymentOptions: paymentOptionsFor(b),
      cancellationTiers: snapshot.tiers ?? [],
      waivers:
        b.status === 'CANCELLED'
          ? []
          : b.waivers.map((w) => ({
              token: w.token,
              passengerName: w.passenger
                ? `${w.passenger.firstName} ${w.passenger.lastName}`
                : null,
              status: w.status,
            })),
      documents: [] as { docType: string; number: string; pdfUrl: string }[],
    };
  }
}
