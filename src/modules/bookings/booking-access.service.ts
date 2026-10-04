import { Injectable, UnauthorizedException } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { generateToken, sha256 } from './booking-support';

type Db = PrismaService | Prisma.TransactionClient;

const DAY = 86_400_000;

/** Tokens de "mi reserva": se entregan una vez y solo se guarda su hash. */
@Injectable()
export class BookingAccessService {
  constructor(private readonly prisma: PrismaService) {}

  /** Crea un token y devuelve el valor en claro. Vale hasta 30 días después de la salida. */
  async issue(
    db: Db,
    bookingId: string,
    departureStartsAt: Date,
  ): Promise<string> {
    const token = generateToken(32);
    const expiresAt = new Date(
      Math.max(Date.now() + 30 * DAY, departureStartsAt.getTime() + 30 * DAY),
    );
    await db.bookingAccessToken.create({
      data: { bookingId, tokenHash: sha256(token), expiresAt },
    });
    return token;
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
