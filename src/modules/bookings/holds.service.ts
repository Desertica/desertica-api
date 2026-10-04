import {
  ConflictException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CaptchaService } from '../../common/captcha/captcha.service';
import {
  KEY_VALUE_STORE,
  type KeyValueStore,
} from '../../common/cache/key-value-store';
import { isBlackedOut, isOnSale } from '../catalog/pricing';
import { SeatsService } from '../catalog/seats.service';
import { SettingsService } from '../settings/settings.service';
import { PrismaService } from '../../prisma/prisma.service';
import { generateToken } from './booking-support';

@Injectable()
export class HoldsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly seats: SeatsService,
    private readonly settings: SettingsService,
    private readonly captcha: CaptchaService,
    @Inject(KEY_VALUE_STORE) private readonly store: KeyValueStore,
  ) {}

  /**
   * Bloquea cupo. Toma el candado de la fila de la salida, cuenta lo vendido y
   * lo retenido dentro de la misma transacción y recién entonces inserta: dos
   * peticiones sobre el último cupo se serializan y solo una gana.
   */
  async create(
    departureId: string,
    seatsWanted: number,
    ctx: { ip?: string; turnstileToken?: string } = {},
    now = new Date(),
  ) {
    await this.captcha.verify(ctx.turnstileToken, ctx.ip);
    // Tope por IP: sin él, un solo cliente podría retener todo el cupo renovando bloqueos.
    if (ctx.ip) {
      const hits = await this.store.incr(`holds:ip:${ctx.ip}`, 15 * 60_000);
      if (hits.value > 8 * Number(process.env.THROTTLE_SCALE ?? 1)) {
        throw new HttpException(
          'Too many seat holds from this address',
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    }
    const minutes = await this.settings.getNumber('holdMinutes');
    return this.prisma.$transaction(async (tx) => {
      if (!(await this.seats.lockDeparture(tx, departureId))) {
        throw new NotFoundException('Departure not found');
      }
      const departure = await tx.departure.findUniqueOrThrow({
        where: { id: departureId },
        include: { tourRef: true },
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
        throw new ConflictException({
          message: 'Departure is not on sale',
          details: { reason: 'NOT_ON_SALE' },
        });
      }
      const counts = (await this.seats.countFor([departureId], now, tx)).get(
        departureId,
      )!;
      const left = departure.capacity - counts.sold - counts.held;
      if (seatsWanted > left) {
        throw new ConflictException({
          message: 'Not enough seats left',
          details: { reason: 'NO_CAPACITY', seatsLeft: Math.max(0, left) },
        });
      }
      const hold = await tx.hold.create({
        data: {
          token: generateToken(24),
          departureId,
          seats: seatsWanted,
          expiresAt: new Date(now.getTime() + minutes * 60_000),
        },
      });
      return {
        token: hold.token,
        departureId: hold.departureId,
        seats: hold.seats,
        expiresAt: hold.expiresAt,
      };
    });
  }

  /** Libera el bloqueo; si ya se convirtió en reserva no hace nada. Idempotente. */
  async release(token: string, now = new Date()): Promise<void> {
    await this.prisma.hold.updateMany({
      where: { token, releasedAt: null, booking: { is: null } },
      data: { releasedAt: now },
    });
  }
}
