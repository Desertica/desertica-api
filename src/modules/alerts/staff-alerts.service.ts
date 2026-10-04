import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EnvVars } from '../../config/env.validation';
import { NotificationsService } from '../notifications/notifications.service';

/**
 * Avisos internos sobre dinero que requieren atención del staff (pago tardío,
 * importe inconsistente, reembolso fallido, disputa). Siempre queda en el log;
 * además va por correo a `STAFF_NOTIFY_EMAIL` si está configurado. Nunca lanza.
 */
@Injectable()
export class StaffAlertsService {
  private readonly logger = new Logger(StaffAlertsService.name);

  constructor(
    private readonly notifications: NotificationsService,
    private readonly config: ConfigService<EnvVars, true>,
  ) {}

  async alert(
    code: string,
    data: Record<string, unknown>,
    options: { bookingId?: string } = {},
  ): Promise<void> {
    this.logger.warn(`Payment alert ${code}: ${JSON.stringify(data)}`);
    const to = this.config.get('STAFF_NOTIFY_EMAIL', { infer: true });
    if (!to) return;
    try {
      await this.notifications.sendEmail(
        { to, template: 'payment_staff_alert', data: { code, ...data } },
        options,
      );
    } catch (error) {
      this.logger.error(
        `Could not send alert ${code}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
