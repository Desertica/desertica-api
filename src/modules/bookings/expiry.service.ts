import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EnvVars } from '../../config/env.validation';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';

const ADVISORY_KEY = 'desertica:expiry-sweep';
/** Un pago en curso (3DS, transferencia en validación) frena el vencimiento este tiempo. */
const IN_FLIGHT_GRACE_MS = 30 * 60_000;

/**
 * Barrido de vencimientos, basado en la base de datos (sin Redis):
 * - Reservas web sin pagar cuya ventana de pago venció: se cancelan y liberan el cupo.
 * - Bloqueos de cupo vencidos que nunca fueron reserva: se marcan liberados.
 * - Registros de idempotencia de más de 7 días: se borran.
 *
 * El conteo de cupo ya ignora los bloqueos vencidos aunque este barrido no
 * corra; el barrido existe para que el estado de la reserva y los reportes
 * sean correctos. Un candado de aviso de Postgres evita que dos instancias
 * barran a la vez.
 */
@Injectable()
export class ExpiryService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(ExpiryService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly config: ConfigService<EnvVars, true>,
  ) {}

  onApplicationBootstrap(): void {
    const seconds = this.config.get('EXPIRY_SWEEP_SECONDS', { infer: true });
    if (seconds <= 0 || this.config.get('NODE_ENV', { infer: true }) === 'test')
      return;
    this.timer = setInterval(() => {
      this.runOnce().catch((error: unknown) =>
        this.logger.error(
          `Sweep failed: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    }, seconds * 1000);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async runOnce(
    now = new Date(),
  ): Promise<{ bookings: number; holds: number }> {
    // Candado de transacción: se libera solo al terminar y no depende de qué
    // conexión del pool atienda cada consulta.
    return this.prisma.$transaction(
      async (tx) => {
        const row = await tx.$queryRaw<{ locked: boolean }[]>`
          SELECT pg_try_advisory_xact_lock(hashtext(${ADVISORY_KEY})) AS locked`;
        if (!row[0]?.locked) return { bookings: 0, holds: 0 };
        return this.sweep(now);
      },
      { timeout: 120_000, maxWait: 5_000 },
    );
  }

  private async sweep(now: Date) {
    const candidates = await this.prisma.booking.findMany({
      where: {
        status: 'PENDING_PAYMENT',
        source: 'WEB',
        paidCents: 0,
        hold: { is: { expiresAt: { lte: now } } },
        payments: {
          none: {
            status: { in: ['PENDING', 'REQUIRES_ACTION'] },
            updatedAt: { gt: new Date(now.getTime() - IN_FLIGHT_GRACE_MS) },
          },
        },
      },
      select: { id: true },
      take: 200,
    });

    let bookings = 0;
    for (const { id } of candidates) {
      const expired = await this.expireBooking(id, now);
      if (expired) bookings++;
    }

    const holds = await this.prisma.hold.updateMany({
      where: {
        releasedAt: null,
        expiresAt: { lte: now },
        booking: { is: null },
      },
      data: { releasedAt: now },
    });
    await this.prisma.idempotencyRecord.deleteMany({
      where: { createdAt: { lt: new Date(now.getTime() - 7 * 86_400_000) } },
    });
    if (bookings > 0 || holds.count > 0) {
      this.logger.log(
        `Expired ${bookings} unpaid bookings and ${holds.count} holds`,
      );
    }
    return { bookings, holds: holds.count };
  }

  private async expireBooking(id: string, now: Date): Promise<boolean> {
    const done = await this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "Booking" WHERE "id" = ${id} FOR UPDATE`;
      if (locked.length === 0) return false;
      // Se revalida bajo candado: un pago pudo confirmarla entre la consulta y ahora.
      const booking = await tx.booking.findUniqueOrThrow({
        where: { id },
        include: { hold: true },
      });
      if (
        booking.status !== 'PENDING_PAYMENT' ||
        booking.paidCents > 0 ||
        !booking.hold ||
        booking.hold.expiresAt > now
      ) {
        return false;
      }
      await tx.booking.update({
        where: { id },
        data: {
          status: 'CANCELLED',
          cancelledAt: now,
          cancelReason: 'payment_timeout',
        },
      });
      await tx.hold.update({
        where: { id: booking.hold.id },
        data: { releasedAt: now },
      });
      await this.audit.record(
        {
          action: 'booking.expire',
          entity: 'Booking',
          entityId: id,
          before: { status: 'PENDING_PAYMENT' },
          after: { status: 'CANCELLED', reason: 'payment_timeout' },
        },
        tx,
      );
      return true;
    });
    if (done) {
      const b = await this.prisma.booking.findUniqueOrThrow({
        where: { id },
        include: { customer: true, departure: { include: { tourRef: true } } },
      });
      await this.notifications.sendEmail(
        {
          to: b.customer.email,
          template: 'booking_expired',
          locale: b.locale,
          data: {
            reference: b.reference,
            tourSlug: b.departure.tourRef.slug,
            startsAt: b.departure.startsAt.toISOString(),
          },
        },
        { bookingId: id },
      );
    }
    return done;
  }
}
