import {
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  computeDeposit,
  priceBooking,
  type CancellationTier,
} from '../../common/money';
import { limaMonthRange } from '../../common/time/lima';
import { Currency, TourFormat } from '../../generated/prisma/enums';
import { PrismaService } from '../../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { isBlackedOut, isOnSale, selectRule } from './pricing';
import { SeatsService } from './seats.service';

@Injectable()
export class AvailabilityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly seats: SeatsService,
    private readonly settings: SettingsService,
  ) {}

  /** Salidas vendibles de un mes (hora de Lima) con cupo restante y precio. */
  async forMonth(
    slug: string,
    q: {
      month: string;
      currency: Currency;
      format?: TourFormat;
      language?: string;
    },
    now = new Date(),
  ) {
    const tour = await this.prisma.tourRef.findUnique({ where: { slug } });
    if (!tour?.active) throw new NotFoundException('Tour not found');

    const { from, to } = limaMonthRange(q.month);
    const [departures, rules, blackouts] = await Promise.all([
      this.prisma.departure.findMany({
        where: {
          tourRefId: tour.id,
          status: 'OPEN',
          startsAt: { gte: from, lt: to },
          ...(q.format ? { format: q.format } : {}),
          ...(q.language ? { language: q.language } : {}),
        },
        orderBy: { startsAt: 'asc' },
      }),
      this.prisma.priceRule.findMany({
        where: {
          tourRefId: tour.id,
          currency: q.currency,
          active: true,
          ...(q.format ? { format: q.format } : {}),
        },
      }),
      this.prisma.blackout.findMany({
        where: {
          OR: [{ tourRefId: null }, { tourRefId: tour.id }],
          endsOn: { gte: from },
          startsOn: { lt: to },
        },
      }),
    ]);
    const counts = await this.seats.countFor(
      departures.map((d) => d.id),
      now,
    );

    const data = departures.flatMap((d) => {
      if (!isOnSale(d, now) || isBlackedOut(blackouts, tour.id, d.startsAt)) {
        return [];
      }
      const rule = selectRule(
        rules.filter((r) => r.format === d.format),
        d.startsAt,
      );
      if (!rule) return [];
      const c = counts.get(d.id)!;
      return [
        {
          departureId: d.id,
          startsAt: d.startsAt,
          language: d.language,
          format: d.format,
          seatsLeft: Math.max(0, d.capacity - c.sold - c.held),
          meetingPoint: d.meetingPoint,
          price: {
            currency: rule.currency,
            unit: rule.unit,
            adultCents: rule.adultCents,
            childCents: rule.childCents,
            groupCents: rule.groupCents,
          },
        },
      ];
    });
    return { data };
  }

  /**
   * Cotización de una salida para un grupo. Verifica que la salida esté a la
   * venta y tenga cupo; `forBooking` la reutilizan holds y reservas.
   */
  async quote(
    input: {
      departureId: string;
      adults: number;
      children?: number;
      currency: Currency;
    },
    now = new Date(),
  ) {
    const departure = await this.prisma.departure.findUnique({
      where: { id: input.departureId },
      include: { tourRef: { include: { cancellationPolicy: true } } },
    });
    if (!departure)
      throw new UnprocessableEntityException('Unknown departureId');
    const children = input.children ?? 0;
    const people = input.adults + children;

    const blackouts = await this.prisma.blackout.findMany({
      where: {
        OR: [{ tourRefId: null }, { tourRefId: departure.tourRefId }],
      },
    });
    if (
      !departure.tourRef.active ||
      !isOnSale(departure, now) ||
      isBlackedOut(blackouts, departure.tourRefId, departure.startsAt)
    ) {
      throw new UnprocessableEntityException('Departure is not on sale');
    }
    const c = (await this.seats.countFor([departure.id], now)).get(
      departure.id,
    )!;
    if (people > departure.capacity - c.sold - c.held) {
      throw new UnprocessableEntityException('Not enough seats left');
    }

    const resolved = await this.priceFor(departure, input.currency, people);
    const depositPercent = await this.settings.getNumber('depositPercent');
    const price = priceBooking(resolved.rule, input.adults, children);
    const policy = departure.tourRef.cancellationPolicy;
    return {
      currency: input.currency,
      totalCents: price.totalCents,
      depositCents: computeDeposit(price.totalCents, depositPercent),
      lines: price.lines,
      cancellationTiers: policy
        ? (policy.tiers as unknown as CancellationTier[])
        : [],
    };
  }

  /** Regla de precio aplicable o 422 si la salida no se vende en esa moneda/grupo. */
  async priceFor(
    departure: { tourRefId: string; format: TourFormat; startsAt: Date },
    currency: Currency,
    people: number,
  ) {
    const rules = await this.prisma.priceRule.findMany({
      where: {
        tourRefId: departure.tourRefId,
        currency,
        format: departure.format,
        active: true,
      },
    });
    const rule = selectRule(rules, departure.startsAt, people);
    if (!rule) {
      throw new UnprocessableEntityException(
        'No price available for this departure, currency and group size',
      );
    }
    return { rule };
  }
}
