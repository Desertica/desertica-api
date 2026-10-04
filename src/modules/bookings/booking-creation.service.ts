import {
  ConflictException,
  ForbiddenException,
  GoneException,
  Injectable,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  computeDeposit,
  priceBooking,
  type CancellationTier,
} from '../../common/money';
import { Prisma } from '../../generated/prisma/client';
import { Currency } from '../../generated/prisma/enums';
import { CaptchaService } from '../../common/captcha/captcha.service';
import { IdempotencyService } from '../../common/idempotency/idempotency.service';
import { EnvVars } from '../../config/env.validation';
import { PrismaService } from '../../prisma/prisma.service';
import { BlockedIdentitiesService } from '../admin/blocked-identities.service';
import { AuditService } from '../audit/audit.service';
import { AvailabilityService } from '../catalog/availability.service';
import { isBlackedOut, isOnSale } from '../catalog/pricing';
import { SeatsService } from '../catalog/seats.service';
import { LegalService } from '../compliance/legal.service';
import { NotificationsService } from '../notifications/notifications.service';
import { SettingsService } from '../settings/settings.service';
import { BookingAccessService } from './booking-access.service';
import { bookingPending, toBookingDto } from './booking.mappers';
import {
  generateReference,
  generateToken,
  normalizeEmail,
  toJson,
  validateBilling,
} from './booking-support';
import {
  CreateManualBookingDto,
  CreatePublicBookingDto,
  CustomerInputDto,
  PassengerInputDto,
  StaffQuoteDto,
} from './dto/booking.dto';
import { links } from './links';
import { BookingViewService } from './booking-view.service';

type Tx = Prisma.TransactionClient;

interface NewBooking {
  source: 'WEB' | 'MANUAL';
  status: 'PENDING_PAYMENT' | 'CONFIRMED';
  departure: { id: string; tourRefId: string };
  tourRef: {
    id: string;
    requiresWaiver: boolean;
    cancellationPolicy: {
      id: string;
      key: string;
      name: string;
      version: number;
      tiers: Prisma.JsonValue;
      depositRefundable: boolean;
    } | null;
  };
  currency: Currency;
  adults: number;
  children: number;
  totalCents: number;
  depositCents: number | null;
  priceSnapshot: Prisma.InputJsonValue;
  customer: CustomerInputDto;
  passengers: PassengerInputDto[];
  billing: Prisma.InputJsonValue;
  holdId?: string;
  notes?: string;
  locale: string;
  attribution?: Prisma.InputJsonValue;
  anonymousId?: string;
  createdByUserId?: string;
}

@Injectable()
export class BookingCreationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly seats: SeatsService,
    private readonly availability: AvailabilityService,
    private readonly settings: SettingsService,
    private readonly legal: LegalService,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
    private readonly captcha: CaptchaService,
    private readonly blocked: BlockedIdentitiesService,
    private readonly access: BookingAccessService,
    private readonly notifications: NotificationsService,
    private readonly view: BookingViewService,
    private readonly config: ConfigService<EnvVars, true>,
  ) {}

  // ------------------------------------------------------------ Público

  async createPublic(
    dto: CreatePublicBookingDto,
    ctx: { ip?: string; userAgent?: string; idempotencyKey?: string },
    now = new Date(),
  ) {
    await this.blocked.assertAllowed({
      email: dto.customer.email,
      ip: ctx.ip,
    });
    // Un reintento con la misma clave no vuelve a pedir el captcha (el token es de un solo uso).
    const retry =
      ctx.idempotencyKey !== undefined &&
      (await this.idempotency.has('createPublicBooking', ctx.idempotencyKey));
    if (!retry) await this.captcha.verify(dto.turnstileToken, ctx.ip);
    validateBilling(dto.billing);
    const children = dto.children ?? 0;
    const people = dto.adults + children;
    if (dto.passengers && dto.passengers.length > people) {
      throw new UnprocessableEntityException(
        'There are more passengers than seats',
      );
    }
    const locale = dto.locale ?? dto.customer.locale ?? 'es';

    // El token de acceso se emite dentro de la transacción pero no se guarda en
    // la respuesta idempotente (sería un secreto en claro en la base).
    let accessToken: string | undefined;
    let bookingId = '';
    const { turnstileToken: _ignored, ...hashable } = dto;
    void _ignored;

    const result = await this.idempotency.run(
      {
        scope: 'createPublicBooking',
        key: ctx.idempotencyKey,
        request: hashable,
      },
      async (tx) => {
        const holdRows = await tx.$queryRaw<{ id: string }[]>`
          SELECT "id" FROM "Hold" WHERE "token" = ${dto.holdToken} FOR UPDATE`;
        if (holdRows.length === 0) {
          throw new GoneException('The seat hold does not exist or expired');
        }
        const hold = await tx.hold.findUniqueOrThrow({
          where: { id: holdRows[0].id },
          include: { booking: { select: { id: true } } },
        });
        if (hold.booking) {
          throw new ConflictException('The seat hold was already used');
        }
        if (hold.releasedAt || hold.expiresAt <= now) {
          throw new GoneException('The seat hold does not exist or expired');
        }
        if (hold.seats !== people) {
          throw new UnprocessableEntityException(
            'adults + children must match the seats held',
          );
        }

        await this.seats.lockDeparture(tx, hold.departureId);
        const departure = await tx.departure.findUniqueOrThrow({
          where: { id: hold.departureId },
          include: { tourRef: { include: { cancellationPolicy: true } } },
        });
        const blackouts = await tx.blackout.findMany({
          where: {
            OR: [{ tourRefId: null }, { tourRefId: departure.tourRefId }],
          },
        });
        if (
          !departure.tourRef.active ||
          !isOnSale(departure, now) ||
          isBlackedOut(blackouts, departure.tourRefId, departure.startsAt)
        ) {
          throw new ConflictException('Departure is no longer on sale');
        }

        const docs = await this.legal.assertAcceptable(
          dto.acceptedLegalDocumentIds,
          locale,
          tx,
        );
        const { rule } = await this.availability.priceFor(
          departure,
          dto.currency,
          people,
        );
        const price = priceBooking(rule, dto.adults, children);
        const depositPercent = await this.settings.getNumber('depositPercent');
        const depositCents =
          dto.paymentKind === 'DEPOSIT'
            ? computeDeposit(price.totalCents, depositPercent)
            : null;

        const booking = await this.persist(tx, {
          source: 'WEB',
          status: 'PENDING_PAYMENT',
          departure,
          tourRef: departure.tourRef,
          currency: dto.currency,
          adults: dto.adults,
          children,
          totalCents: price.totalCents,
          depositCents,
          priceSnapshot: toJson({
            ruleId: rule.id,
            unit: rule.unit,
            currency: dto.currency,
            lines: price.lines,
            totalCents: price.totalCents,
            depositPercent: depositCents === null ? null : depositPercent,
          }),
          customer: dto.customer,
          passengers: dto.passengers ?? [],
          billing: toJson(dto.billing),
          holdId: hold.id,
          notes: dto.notes,
          locale,
          attribution: dto.attribution ? toJson(dto.attribution) : undefined,
          anonymousId: dto.anonymousId,
        });

        // El bloqueo pasa a ser la ventana de pago de la reserva.
        const windowMinutes = this.config.get('PAYMENT_WINDOW_MINUTES', {
          infer: true,
        });
        await tx.hold.update({
          where: { id: hold.id },
          data: { expiresAt: new Date(now.getTime() + windowMinutes * 60_000) },
        });
        await tx.acceptance.createMany({
          data: docs.map((d) => ({
            legalDocumentId: d.id,
            bookingId: booking.id,
            customerId: booking.customerId,
            ip: ctx.ip ?? null,
            userAgent: ctx.userAgent?.slice(0, 300) ?? null,
          })),
        });
        await this.audit.record(
          {
            action: 'booking.create',
            entity: 'Booking',
            entityId: booking.id,
            after: {
              reference: booking.reference,
              source: 'WEB',
              totalCents: booking.totalCents,
              currency: booking.currency,
              acceptedLegalDocumentIds: docs.map((d) => d.id),
            },
            ip: ctx.ip,
          },
          tx,
        );
        accessToken = await this.access.issue(
          tx,
          booking.id,
          departure.startsAt,
        );
        bookingId = booking.id;

        return {
          status: 201,
          body: {
            // Solo lo que no es secreto ni cambia: la vista se arma al responder.
            reference: booking.reference,
          },
        };
      },
    );

    const found = await this.prisma.booking.findUniqueOrThrow({
      where: { reference: result.body.reference },
      include: { departure: true },
    });
    if (result.replayed) {
      // Misma petición repetida: se devuelve la reserva actual y se emite un acceso nuevo.
      bookingId = found.id;
      accessToken = await this.access.issue(
        this.prisma,
        found.id,
        found.departure.startsAt,
      );
    } else {
      await this.sendCreatedEmail(bookingId, accessToken!);
    }
    const view = await this.view.toPublicById(found.id);
    return {
      status: result.status,
      body: {
        booking: view,
        paymentOptions: view.paymentOptions,
        accessToken: accessToken!,
      },
    };
  }

  // ------------------------------------------------------------- Manual

  /**
   * Cotización de una reserva manual: mismas reglas que `createManual` (no
   * exige que la salida esté a la venta), con precio acordado opcional.
   */
  async staffQuote(
    dto: StaffQuoteDto,
    actor: { permissions: ReadonlySet<string> },
  ) {
    if (
      dto.overrideTotalCents !== undefined &&
      !actor.permissions.has('bookings:override')
    ) {
      throw new ForbiddenException({
        message: 'Missing permission',
        details: { required: ['bookings:override'] },
      });
    }
    const departure = await this.prisma.departure.findUnique({
      where: { id: dto.departureId },
      include: { tourRef: { include: { cancellationPolicy: true } } },
    });
    if (!departure) {
      throw new UnprocessableEntityException('Unknown departureId');
    }
    if (departure.status === 'CANCELLED' || departure.status === 'COMPLETED') {
      throw new UnprocessableEntityException(
        `Departure is ${departure.status}`,
      );
    }
    const children = dto.children ?? 0;
    const people = dto.adults + children;
    const counts = (await this.seats.countFor([departure.id])).get(
      departure.id,
    )!;
    if (people > departure.capacity - counts.sold - counts.held) {
      throw new UnprocessableEntityException('Not enough seats left');
    }

    let priced: ReturnType<typeof priceBooking> | null = null;
    try {
      const { rule } = await this.availability.priceFor(
        departure,
        dto.currency,
        people,
      );
      priced = priceBooking(rule, dto.adults, children);
    } catch (error) {
      // Sin regla solo se cotiza con precio acordado.
      if (dto.overrideTotalCents === undefined) throw error;
    }
    const totalCents = dto.overrideTotalCents ?? priced!.totalCents;
    const lines =
      dto.overrideTotalCents === undefined
        ? priced!.lines
        : [
            {
              label: 'agreed',
              quantity: 1,
              unitCents: totalCents,
              totalCents,
            },
          ];
    const depositPercent = await this.settings.getNumber('depositPercent');
    const policy = departure.tourRef.cancellationPolicy;
    return {
      currency: dto.currency,
      totalCents,
      depositCents: computeDeposit(totalCents, depositPercent),
      lines,
      cancellationTiers: policy
        ? (policy.tiers as unknown as CancellationTier[])
        : [],
    };
  }

  async createManual(
    dto: CreateManualBookingDto,
    actor: { id: string; permissions: ReadonlySet<string> },
    ctx: { ip?: string; idempotencyKey?: string },
  ) {
    validateBilling(dto.billing);
    if (
      dto.overrideTotalCents !== undefined &&
      !actor.permissions.has('bookings:override')
    ) {
      throw new ForbiddenException({
        message: 'Missing permission',
        details: { required: ['bookings:override'] },
      });
    }
    const children = dto.children ?? 0;
    const people = dto.adults + children;
    if (dto.passengers && dto.passengers.length > people) {
      throw new UnprocessableEntityException(
        'There are more passengers than seats',
      );
    }

    const result = await this.idempotency.run(
      {
        scope: `createManualBooking:${actor.id}`,
        key: ctx.idempotencyKey,
        request: dto,
      },
      async (tx) => {
        if (!(await this.seats.lockDeparture(tx, dto.departureId))) {
          throw new UnprocessableEntityException('Unknown departureId');
        }
        const departure = await tx.departure.findUniqueOrThrow({
          where: { id: dto.departureId },
          include: { tourRef: { include: { cancellationPolicy: true } } },
        });
        if (
          departure.status === 'CANCELLED' ||
          departure.status === 'COMPLETED'
        ) {
          throw new ConflictException(`Departure is ${departure.status}`);
        }
        const counts = (
          await this.seats.countFor([departure.id], new Date(), tx)
        ).get(departure.id)!;
        const left = departure.capacity - counts.sold - counts.held;
        if (people > left) {
          throw new ConflictException({
            message: 'Not enough seats left',
            details: { seatsLeft: Math.max(0, left) },
          });
        }

        let listTotal: number | null = null;
        let rule: { id: string; unit: string } | null = null;
        let lines: unknown = [];
        try {
          const found = await this.availability.priceFor(
            departure,
            dto.currency,
            people,
          );
          const price = priceBooking(found.rule, dto.adults, children);
          listTotal = price.totalCents;
          lines = price.lines;
          rule = found.rule;
        } catch (error) {
          // Sin regla solo se puede vender con precio acordado.
          if (dto.overrideTotalCents === undefined) throw error;
        }
        const totalCents = dto.overrideTotalCents ?? listTotal!;
        const depositCents = dto.depositCents ?? null;
        if (depositCents !== null && depositCents > totalCents) {
          throw new UnprocessableEntityException(
            'depositCents exceeds the total',
          );
        }
        const threshold = depositCents ?? totalCents;

        const booking = await this.persist(tx, {
          source: 'MANUAL',
          status: threshold === 0 ? 'CONFIRMED' : 'PENDING_PAYMENT',
          departure,
          tourRef: departure.tourRef,
          currency: dto.currency,
          adults: dto.adults,
          children,
          totalCents,
          depositCents,
          priceSnapshot: toJson({
            ruleId: rule?.id ?? null,
            unit: rule?.unit ?? null,
            currency: dto.currency,
            lines,
            totalCents,
            override:
              dto.overrideTotalCents === undefined
                ? null
                : {
                    listTotalCents: listTotal,
                    overrideTotalCents: dto.overrideTotalCents,
                    byUserId: actor.id,
                  },
          }),
          customer: dto.customer,
          passengers: dto.passengers ?? [],
          billing: toJson(dto.billing),
          notes: dto.notes,
          locale: dto.customer.locale ?? 'es',
          createdByUserId: actor.id,
        });
        await this.audit.record(
          {
            actorUserId: actor.id,
            action: 'booking.create',
            entity: 'Booking',
            entityId: booking.id,
            after: {
              reference: booking.reference,
              source: 'MANUAL',
              totalCents,
              currency: dto.currency,
              override: dto.overrideTotalCents !== undefined,
            },
            ip: ctx.ip,
          },
          tx,
        );
        const full = await tx.booking.findUniqueOrThrow({
          where: { id: booking.id },
          include: this.view.fullInclude,
        });
        return { status: 201, body: toBookingDto(full) };
      },
    );

    if (!result.replayed && dto.sendConfirmation !== false) {
      const token = await this.access.issue(
        this.prisma,
        result.body.id,
        result.body.startsAt,
      );
      await this.sendCreatedEmail(result.body.id, token);
    }
    return result;
  }

  // ------------------------------------------------------------ Común

  /** Cliente, reserva, pasajeros y descargos pendientes. */
  private async persist(tx: Tx, p: NewBooking) {
    const customer = await this.upsertCustomer(
      tx,
      p.customer,
      p.locale,
      p.source === 'MANUAL',
    );
    const policy = p.tourRef.cancellationPolicy;
    const cancellationSnapshot = policy
      ? {
          policyId: policy.id,
          key: policy.key,
          name: policy.name,
          version: policy.version,
          tiers: policy.tiers,
          depositRefundable: policy.depositRefundable,
        }
      : { policyId: null, tiers: [], depositRefundable: false };

    let reference = generateReference();
    while (await tx.booking.findUnique({ where: { reference } })) {
      reference = generateReference();
    }
    const booking = await tx.booking.create({
      data: {
        reference,
        status: p.status,
        source: p.source,
        departureId: p.departure.id,
        customerId: customer.id,
        holdId: p.holdId ?? null,
        currency: p.currency,
        adults: p.adults,
        children: p.children,
        totalCents: p.totalCents,
        depositCents: p.depositCents,
        priceSnapshot: p.priceSnapshot,
        cancellationSnapshot,
        locale: p.locale,
        notes: p.notes ?? null,
        billing: p.billing,
        attribution: p.attribution,
        anonymousId: p.anonymousId ?? null,
        createdByUserId: p.createdByUserId ?? null,
      },
    });

    const passengerIds: (string | null)[] = [];
    for (const passenger of p.passengers) {
      const created = await tx.passenger.create({
        data: {
          bookingId: booking.id,
          firstName: passenger.firstName,
          lastName: passenger.lastName,
          idDocType: passenger.idDocType,
          idDocNumber: passenger.idDocNumber,
          birthDate: passenger.birthDate
            ? new Date(`${passenger.birthDate}T00:00:00.000Z`)
            : null,
          nationality: passenger.nationality,
          emergencyContactName: passenger.emergencyContactName,
          emergencyContactPhone: passenger.emergencyContactPhone,
        },
      });
      passengerIds.push(created.id);
    }
    if (p.tourRef.requiresWaiver) {
      // Un descargo por pasajero registrado; el resto de asientos, descargos sin nombre.
      const seats = p.adults + p.children;
      while (passengerIds.length < seats) passengerIds.push(null);
      await tx.waiver.createMany({
        data: passengerIds.map((passengerId) => ({
          token: generateToken(24),
          bookingId: booking.id,
          passengerId,
          tourRefId: p.tourRef.id,
          version: 1,
        })),
      });
    }
    return booking;
  }

  /**
   * Reutiliza al cliente que coincide en correo y nombre; si no, crea otro.
   * Nunca pisa nombre ni correo de un cliente existente.
   */
  private async upsertCustomer(
    tx: Tx,
    input: CustomerInputDto,
    locale: string,
    updateExisting: boolean,
  ) {
    const email = normalizeEmail(input.email);
    const existing = await tx.customer.findFirst({
      where: {
        email,
        firstName: { equals: input.firstName.trim(), mode: 'insensitive' },
        lastName: { equals: input.lastName.trim(), mode: 'insensitive' },
      },
      orderBy: { createdAt: 'asc' },
    });
    const details = {
      phone: input.phone,
      country: input.country?.toUpperCase(),
      idDocType: input.idDocType,
      idDocNumber: input.idDocNumber,
    };
    if (existing) {
      // Un anónimo que conoce correo y nombre no debe poder pisar datos guardados.
      return updateExisting
        ? tx.customer.update({ where: { id: existing.id }, data: details })
        : existing;
    }
    return tx.customer.create({
      data: {
        email,
        firstName: input.firstName.trim(),
        lastName: input.lastName.trim(),
        ...details,
        locale,
      },
    });
  }

  private async sendCreatedEmail(bookingId: string, token: string) {
    const booking = await this.prisma.booking.findUniqueOrThrow({
      where: { id: bookingId },
      include: {
        customer: true,
        departure: { include: { tourRef: true } },
        waivers: true,
      },
    });
    const base = this.config.get('PUBLIC_WEB_URL', { infer: true });
    await this.notifications.sendEmail(
      {
        to: booking.customer.email,
        template: 'booking_created',
        locale: booking.locale,
        data: {
          reference: booking.reference,
          tourSlug: booking.departure.tourRef.slug,
          startsAt: booking.departure.startsAt.toISOString(),
          currency: booking.currency,
          totalCents: booking.totalCents,
          pendingCents: bookingPending(booking),
          bookingUrl: links.booking(base, booking.reference, token),
          waiverUrls: booking.waivers
            .filter((w) => w.status === 'PENDING')
            .map((w) => links.waiver(base, w.token)),
        },
      },
      { bookingId },
    );
  }
}
