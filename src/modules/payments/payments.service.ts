import {
  BadGatewayException,
  ConflictException,
  GoneException,
  NotFoundException,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { IdempotencyService } from '../../common/idempotency/idempotency.service';
import { pendingCents } from '../../common/money';
import { Prisma } from '../../generated/prisma/client';
import type { Currency, PaymentKind } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { GatewayRegistry } from './gateway.registry';
import { PaymentEventsService } from './payment-events.service';
import {
  GatewayError,
  GatewayNotConfiguredError,
  type GatewayPayment,
} from './providers/payment-gateway';

type Gateway = 'STRIPE' | 'CULQI';

/** Un cobro abierto de un enlace bloquea otro intento durante este tiempo. */
const LINK_IN_PROGRESS_MS = 10 * 60_000;
const MAX_3DS_BYTES = 4_000;

export interface CulqiInput {
  token: string;
  email: string;
  /** Pago `REQUIRES_ACTION` que se continúa con la autenticación 3DS. */
  paymentId?: string;
  authentication3DS?: Record<string, unknown>;
}

interface StartParams {
  provider: Gateway;
  /** Reserva (flujo de la reserva) o enlace (flujo del enlace de pago). */
  booking?: { id: string; kind: PaymentKind };
  linkToken?: string;
  idempotencyKey?: string;
  culqi?: CulqiInput;
}

/**
 * Inicio de cobros por pasarela desde los endpoints públicos. El importe y la
 * moneda salen siempre de la reserva (o del enlace), nunca del cliente.
 *
 * Flujo en dos fases: (1) una transacción con la reserva bloqueada valida y
 * crea el `Payment` en `PENDING` (junto con la fila de `Idempotency-Key`);
 * (2) fuera de esa transacción, y bajo un candado por pago, se llama a la
 * pasarela. Repetir la petición con la misma clave reanuda la fase 2 sin crear
 * otro cobro.
 */
@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gateways: GatewayRegistry,
    private readonly idempotency: IdempotencyService,
    private readonly events: PaymentEventsService,
    private readonly audit: AuditService,
  ) {}

  // ------------------------------------------------------------ Entradas

  async bookingStripeIntent(
    bookingId: string,
    kind: PaymentKind,
    idempotencyKey?: string,
  ) {
    return this.start({
      provider: 'STRIPE',
      booking: { id: bookingId, kind },
      idempotencyKey,
    });
  }

  async bookingCulqiCharge(
    bookingId: string,
    kind: PaymentKind,
    culqi: CulqiInput,
    idempotencyKey?: string,
  ) {
    return this.start({
      provider: 'CULQI',
      booking: { id: bookingId, kind },
      culqi,
      idempotencyKey,
    });
  }

  async linkStripeIntent(linkToken: string, idempotencyKey?: string) {
    return this.start({ provider: 'STRIPE', linkToken, idempotencyKey });
  }

  async linkCulqiCharge(
    linkToken: string,
    culqi: CulqiInput,
    idempotencyKey?: string,
  ) {
    return this.start({ provider: 'CULQI', linkToken, culqi, idempotencyKey });
  }

  // --------------------------------------------------------------- Fases

  private async start(params: StartParams) {
    const gateway = this.gateways.get(params.provider);
    if (params.culqi?.authentication3DS) {
      if (
        JSON.stringify(params.culqi.authentication3DS).length > MAX_3DS_BYTES
      ) {
        throw new UnprocessableEntityException(
          'authentication3DS is too large',
        );
      }
    }
    if (params.provider === 'STRIPE') {
      try {
        gateway.publicKey();
      } catch (error) {
        throw this.mapGatewayError(error);
      }
    }

    const scope = params.linkToken
      ? `pay:${params.provider}:link:${params.linkToken.slice(0, 16)}`
      : `pay:${params.provider}:${params.booking!.id}`;
    const reserved = await this.idempotency.run(
      {
        scope,
        key: params.idempotencyKey,
        // El token de Culqi es de un solo uso: no entra en el hash de la petición.
        request: {
          kind: params.booking?.kind,
          link: params.linkToken,
          paymentId: params.culqi?.paymentId,
          email: params.culqi?.email,
        },
      },
      async (tx) => ({
        status: 201,
        body: await this.reserve(tx, params, gateway.currencies),
      }),
    );
    return this.drive(reserved.body.paymentId, params);
  }

  /** Fase 1: valida bajo candado y crea (o reanuda) el `Payment`. */
  private async reserve(
    tx: Prisma.TransactionClient,
    params: StartParams,
    currencies: readonly Currency[],
  ): Promise<{ paymentId: string }> {
    let bookingId = params.booking?.id;
    let kind = params.booking?.kind;
    let link: Prisma.PaymentLinkGetPayload<object> | null = null;
    if (params.linkToken) {
      link = await tx.paymentLink.findUnique({
        where: { token: params.linkToken },
      });
      if (!link) throw new NotFoundException('Payment link not found');
      bookingId = link.bookingId;
      kind = link.kind;
    }
    await tx.$queryRaw`SELECT "id" FROM "Booking" WHERE "id" = ${bookingId} FOR UPDATE`;
    const booking = await tx.booking.findUniqueOrThrow({
      where: { id: bookingId },
    });
    if (link) {
      // Releer bajo candado: un pago simultáneo pudo usar el enlace.
      link = await tx.paymentLink.findUniqueOrThrow({ where: { id: link.id } });
      if (link.usedAt || link.expiresAt <= new Date()) {
        throw new GoneException('The payment link expired or was already used');
      }
    }
    if (
      booking.status !== 'PENDING_PAYMENT' &&
      booking.status !== 'CONFIRMED'
    ) {
      throw link
        ? new GoneException('The booking can no longer be paid')
        : new ConflictException(`A ${booking.status} booking cannot be paid`);
    }
    if (!currencies.includes(booking.currency)) {
      throw new UnprocessableEntityException(
        `This payment method does not charge ${booking.currency}`,
      );
    }

    const net = booking.paidCents - booking.refundedCents;
    const pending = pendingCents(
      booking.totalCents,
      booking.paidCents,
      booking.refundedCents,
    );
    let amountCents: number;
    if (link) {
      amountCents = Math.min(link.amountCents, pending);
      if (amountCents <= 0)
        throw new GoneException('Nothing is pending anymore');
    } else {
      if (kind !== 'FULL' && booking.depositCents === null) {
        throw new UnprocessableEntityException('The booking has no deposit');
      }
      if (kind === 'DEPOSIT') {
        amountCents = Math.min(booking.depositCents! - net, pending);
      } else if (kind === 'BALANCE') {
        if (net < booking.depositCents!) {
          throw new ConflictException('The deposit has not been paid yet');
        }
        amountCents = pending;
      } else {
        amountCents = pending;
      }
      if (amountCents <= 0) {
        throw new ConflictException('There is nothing pending of that kind');
      }
    }

    // Continuar un cobro de Culqi que esperaba 3DS.
    if (params.culqi?.paymentId) {
      const existing = await tx.payment.findUnique({
        where: { id: params.culqi.paymentId },
      });
      if (
        !existing ||
        existing.bookingId !== booking.id ||
        existing.provider !== 'CULQI' ||
        existing.status !== 'REQUIRES_ACTION'
      ) {
        throw new ConflictException('That payment is not waiting for 3DS');
      }
      return { paymentId: existing.id };
    }

    if (link) {
      const open = await tx.payment.count({
        where: {
          paymentLinkId: link.id,
          status: { in: ['PENDING', 'REQUIRES_ACTION'] },
          createdAt: { gt: new Date(Date.now() - LINK_IN_PROGRESS_MS) },
        },
      });
      if (open > 0) {
        throw new ConflictException('A payment for this link is in progress');
      }
    }

    const payment = await tx.payment.create({
      data: {
        bookingId: booking.id,
        provider: params.provider,
        method: 'CARD',
        kind: kind!,
        status: 'PENDING',
        currency: booking.currency,
        amountCents,
        paymentLinkId: link?.id ?? null,
      },
    });
    await this.audit.record(
      {
        action: 'payment.start',
        entity: 'Payment',
        entityId: payment.id,
        after: {
          bookingId: booking.id,
          provider: params.provider,
          kind,
          amountCents,
          currency: booking.currency,
          paymentLinkId: link?.id ?? null,
        },
      },
      tx,
    );
    return { paymentId: payment.id };
  }

  /** Fase 2: habla con la pasarela (una sola vez por pago) y arma la respuesta. */
  private async drive(paymentId: string, params: StartParams) {
    const gateway = this.gateways.get(params.provider);
    // El candado serializa reintentos simultáneos del mismo pago; el trabajo
    // real usa `this.prisma` para no mezclar la transacción del candado.
    return this.prisma.$transaction(
      async (lock) => {
        await lock.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`pay:${paymentId}`}))`;
        const payment = await this.prisma.payment.findUniqueOrThrow({
          where: { id: paymentId },
          include: { booking: { select: { reference: true } } },
        });
        const description = `Desertica ${payment.booking.reference}`;

        if (params.provider === 'STRIPE') {
          let gw: GatewayPayment;
          try {
            gw = payment.providerRef
              ? await gateway.retrievePayment(payment.providerRef)
              : await gateway.createPayment({
                  paymentId,
                  bookingReference: payment.booking.reference,
                  amountCents: payment.amountCents,
                  currency: payment.currency,
                  description,
                });
          } catch (error) {
            await this.abandon(paymentId, error);
            throw this.mapGatewayError(error);
          }
          if (!payment.providerRef) {
            await this.prisma.payment.update({
              where: { id: paymentId },
              data: { providerRef: gw.providerRef },
            });
          }
          return {
            paymentId,
            clientSecret: gw.clientSecret!,
            publishableKey: gateway.publicKey(),
            amountCents: payment.amountCents,
            currency: 'USD' as const,
          };
        }

        const culqi = params.culqi!;
        const canCharge =
          (payment.status === 'PENDING' && !payment.providerRef) ||
          (payment.status === 'REQUIRES_ACTION' && !!culqi.authentication3DS);
        let failureMessage: string | null = null;
        if (canCharge) {
          let gw: GatewayPayment | undefined;
          try {
            gw = await gateway.createPayment({
              paymentId,
              bookingReference: payment.booking.reference,
              amountCents: payment.amountCents,
              currency: payment.currency,
              description,
              token: culqi.token,
              email: culqi.email,
              authentication3DS: culqi.authentication3DS,
            });
          } catch (error) {
            if (error instanceof GatewayError && error.declined) {
              failureMessage = error.message;
              await this.events.process('CULQI', {
                kind: 'payment',
                eventId: `charge:${paymentId}:FAILED`,
                type: 'charge.declined',
                payment: {
                  providerRef: '',
                  status: 'FAILED',
                  amountCents: payment.amountCents,
                  currency: payment.currency,
                  failureCode: error.code ?? 'card_declined',
                  metadata: { paymentId },
                },
              });
            } else {
              // Sin saber si se cobró: no se marca fallido; el webhook lo resuelve.
              if (error instanceof GatewayNotConfiguredError) {
                await this.abandon(paymentId, error);
              }
              throw this.mapGatewayError(error);
            }
          }
          if (gw) {
            await this.events.process('CULQI', {
              kind: 'payment',
              eventId: `charge:${paymentId}:${gw.status}`,
              type: 'charge.sync',
              payment: {
                ...gw,
                metadata: { ...gw.metadata, paymentId },
              },
            });
          }
        }

        const after = await this.prisma.payment.findUniqueOrThrow({
          where: { id: paymentId },
        });
        const action =
          after.status === 'REQUIRES_ACTION'
            ? {
                type: 'THREE_DS' as const,
                parameters: {
                  amountCents: after.amountCents,
                  currency: after.currency,
                  email: culqi.email,
                },
              }
            : undefined;
        return {
          paymentId,
          status: after.status,
          ...(action ? { action } : {}),
          failureMessage:
            failureMessage ??
            (after.status === 'FAILED' ? 'Payment failed' : null),
        };
      },
      { timeout: 60_000, maxWait: 15_000 },
    );
  }

  /** La pasarela no se pudo usar: el cobro no quedará `PENDING` bloqueando nada. */
  private async abandon(paymentId: string, error: unknown): Promise<void> {
    const code =
      error instanceof GatewayNotConfiguredError
        ? 'gateway_not_configured'
        : 'gateway_error';
    this.logger.error(`Payment ${paymentId} not started: ${String(error)}`);
    await this.prisma.payment
      .updateMany({
        where: { id: paymentId, status: 'PENDING', providerRef: null },
        data: {
          status: code === 'gateway_not_configured' ? 'CANCELLED' : 'FAILED',
          failureCode: code,
        },
      })
      .catch(() => undefined);
  }

  private mapGatewayError(error: unknown): Error {
    if (error instanceof GatewayNotConfiguredError) {
      return new ServiceUnavailableException(
        'The payment method is unavailable',
      );
    }
    if (error instanceof GatewayError) {
      return new BadGatewayException('The payment provider failed');
    }
    return error instanceof Error ? error : new Error(String(error));
  }
}
