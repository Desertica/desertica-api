import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { BackgroundQueue } from '../../common/queue/background-queue';
import { PrismaService } from '../../prisma/prisma.service';
import { TourTitlesService } from '../cms/tour-titles.service';
import { redactEmails } from '../../common/logger/sanitize';
import { MAILER, type Mailer, MailMessage } from './mailer';
import { langOf } from './templates/format';

/**
 * Envía correos y deja constancia en `Notification`. El envío va a la cola en
 * segundo plano: un SMTP lento o caído no retrasa ni rompe la petición; el
 * fallo queda registrado como `FAILED`.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(MAILER) private readonly mailer: Mailer,
    private readonly queue: BackgroundQueue,
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

  /**
   * Crea la fila con `db` (así queda dentro de la transacción del llamador) y
   * devuelve sin esperar al SMTP. El envío y el estado van con `this.prisma`:
   * la transacción ya estará cerrada cuando corra.
   */
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
    const queued = this.queue.enqueue(`email ${message.template}`, () =>
      this.deliver(record.id, message),
    );
    if (!queued) {
      this.logger.error(`Email ${message.template} dropped: queue full`);
      await db.notification.update({
        where: { id: record.id },
        data: { status: 'FAILED', error: 'Cola de envío llena; no se envió' },
      });
    }
  }

  private async deliver(id: string, message: MailMessage): Promise<void> {
    try {
      await this.mailer.send(await this.withTourTitle(message));
      await this.prisma.notification.update({
        where: { id },
        data: { status: 'SENT', sentAt: new Date() },
      });
    } catch (error) {
      // El servidor SMTP suele repetir la dirección del destinatario en su respuesta.
      const text = redactEmails(
        error instanceof Error ? error.message : String(error),
      );
      this.logger.error(`Email ${message.template} failed: ${text}`);
      await this.prisma.notification.update({
        where: { id },
        data: { status: 'FAILED', error: text.slice(0, 500) },
      });
    }
  }
}
