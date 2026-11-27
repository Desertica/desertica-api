import {
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { generateToken, sha256 } from './booking-support';

type Db = PrismaService | Prisma.TransactionClient;

const DAY = 86_400_000;

/** Vencimiento de un enlace de "mi reserva": entre 30 y 90 días desde que se emite. */
export function accessExpiry(departureStartsAt: Date, now: number): number {
  return Math.min(
    Math.max(now + 30 * DAY, departureStartsAt.getTime() + 30 * DAY),
    now + 90 * DAY,
  );
}

/** Tokens de "mi reserva": se entregan una vez y solo se guarda su hash. */
@Injectable()
export class BookingAccessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Crea un token y devuelve el valor en claro. Vale hasta 30 días después de
   * la salida, pero nunca más de 90 días desde que se emite (una reserva con un
   * año de anticipación pide un enlace nuevo con "reenvíame mi enlace").
   */
  async issue(
    db: Db,
    bookingId: string,
    departureStartsAt: Date,
    now = Date.now(),
  ): Promise<string> {
    const token = generateToken(32);
    const expiresAt = new Date(accessExpiry(departureStartsAt, now));
    await db.bookingAccessToken.create({
      data: { bookingId, tokenHash: sha256(token), expiresAt },
    });
    return token;
  }

  /** Anula todos los enlaces de "mi reserva" de una reserva. Devuelve cuántos había. */
  async revokeAll(db: Db, bookingId: string): Promise<number> {
    const { count } = await db.bookingAccessToken.deleteMany({
      where: { bookingId },
    });
    return count;
  }

  /** Acción del personal: anula los enlaces vigentes y lo deja en la bitácora. */
  async revokeByStaff(
    bookingId: string,
    actorId: string,
    ip?: string,
  ): Promise<{ revoked: number }> {
    return this.prisma.$transaction(async (tx) => {
      const booking = await tx.booking.findUnique({
        where: { id: bookingId },
        select: { id: true },
      });
      if (!booking) throw new NotFoundException('Booking not found');
      const revoked = await this.revokeAll(tx, bookingId);
      await this.audit.record(
        {
          actorUserId: actorId,
          action: 'booking.access_revoke',
          entity: 'Booking',
          entityId: bookingId,
          after: { revoked },
          ip,
        },
        tx,
      );
      return { revoked };
    });
  }

  /**
   * Resuelve la reserva a partir de la referencia y el token. Cualquier falla
   * (token ausente, vencido, de otra reserva o referencia inexistente) es el
   * mismo 401: no se puede usar para saber qué referencias existen.
   */
  async authenticate(
    reference: string,
    token: string | undefined,
  ): Promise<string> {
    const invalid = new UnauthorizedException('Invalid booking token');
    if (!token) throw invalid;
    const record = await this.prisma.bookingAccessToken.findUnique({
      where: { tokenHash: sha256(token) },
      include: { booking: { select: { id: true, reference: true } } },
    });
    if (
      !record ||
      record.expiresAt <= new Date() ||
      record.booking.reference !== reference
    ) {
      throw invalid;
    }
    await this.prisma.bookingAccessToken.update({
      where: { id: record.id },
      data: { lastUsedAt: new Date() },
    });
    return record.booking.id;
  }
}
