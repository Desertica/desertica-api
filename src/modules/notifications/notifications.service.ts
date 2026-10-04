import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { MAILER, type Mailer, MailMessage } from './mailer';

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
  ) {}

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
      await this.mailer.send(message);
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
