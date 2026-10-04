import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  KEY_VALUE_STORE,
  type KeyValueStore,
} from '../../common/cache/key-value-store';
import { EnvVars } from '../../config/env.validation';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { BookingAccessService } from './booking-access.service';
import { normalizeEmail, sha256 } from './booking-support';
import { links } from './links';

const HOUR = 3_600_000;

/** "Mi reserva": envía por correo un enlace con un token nuevo. */
@Injectable()
export class PublicAccessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: BookingAccessService,
    private readonly notifications: NotificationsService,
    private readonly config: ConfigService<EnvVars, true>,
    @Inject(KEY_VALUE_STORE) private readonly store: KeyValueStore,
  ) {}

  /**
   * Siempre termina igual (el controlador responde 202) exista o no la
   * reserva. Además del límite por IP, cada correo puede pedir 3 enlaces por
   * hora; pasado eso se ignora en silencio para no revelar nada.
   */
  async request(reference: string, rawEmail: string): Promise<void> {
    const email = normalizeEmail(rawEmail);
    const hits = await this.store.incr(
      `access:${sha256(`${email}|${reference.trim().toUpperCase()}`)}`,
      HOUR,
    );
    if (hits.value > 3) return;

    const booking = await this.prisma.booking.findUnique({
      where: { reference: reference.trim().toUpperCase() },
      include: { customer: true, departure: true },
    });
    if (!booking || normalizeEmail(booking.customer.email) !== email) return;

    const token = await this.access.issue(
      this.prisma,
      booking.id,
      booking.departure.startsAt,
    );
    const base = this.config.get('PUBLIC_WEB_URL', { infer: true });
    await this.notifications.sendEmail(
      {
        to: booking.customer.email,
        template: 'booking_access',
        locale: booking.locale,
        data: {
          reference: booking.reference,
          bookingUrl: links.booking(base, booking.reference, token),
        },
      },
      { bookingId: booking.id },
    );
  }
}
