import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { TourTitlesService } from '../cms/tour-titles.service';
import { MAILER, type Mailer, MailMessage } from './mailer';
import { langOf } from './templates/format';

/**
 * Envía correos y deja constancia en `Notification`. Un fallo al enviar nunca
 * rompe la operación de negocio: queda registrado como `FAILED`.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(MAILER) private readonly mailer: Mailer,
    @Optional() private readonly titles?: TourTitlesService,
  ) {}

  /**
   * Agrega `tourTitle` (en el idioma del correo, con respaldo al título en
   * inglés de `TourRef`) cuando los datos traen `tourSlug`. Es solo cosmético:
   * si no se puede resolver, el correo usa el slug.
   */
  private async withTourTitle(message: MailMessage): Promise<MailMessage> {
    const slug = message.data.tourSlug;
    if (!this.titles || typeof slug !== 'string' || message.data.tourTitle) {
      return message;
    }
    try {
      const tour = await this.prisma.tourRef.findUnique({
        where: { slug },
        select: { slug: true, title: true },
      });
      if (!tour) return message;
      const title = (
        await this.titles.forTours([tour], langOf(message.locale))
      ).get(slug);
      return title
        ? { ...message, data: { ...message.data, tourTitle: title } }
        : message;
    } catch (error) {
      this.logger.warn(
        `No tour title for email ${message.template}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return message;
    }
  }

  async sendEmail(
    message: MailMessage,
    options: { bookingId?: string } = {},
    db: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<void> {
    const record = await db.notification.create({
      data: {
        bookingId: options.bookingId ?? null,
        channel: 'EMAIL',
        template: message.template,
        toAddress: message.to,
      },
    });
    try {
      await this.mailer.send(await this.withTourTitle(message));
      await db.notification.update({
        where: { id: record.id },
        data: { status: 'SENT', sentAt: new Date() },
      });
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      this.logger.error(`Email ${message.template} failed: ${text}`);
      await db.notification.update({
        where: { id: record.id },
        data: { status: 'FAILED', error: text.slice(0, 500) },
      });
    }
  }
}
