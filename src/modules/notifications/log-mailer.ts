import { Logger } from '@nestjs/common';
import { Mailer, MailMessage } from './mailer';

/**
 * Driver de desarrollo: escribe el correo en el log en lugar de enviarlo.
 * Muestra las variables de la plantilla (con los enlaces de acceso), por eso
 * no debe usarse en producción.
 */
export class LogMailer implements Mailer {
  private readonly logger = new Logger('Mailer');
  readonly sent: MailMessage[] = [];

  send(message: MailMessage): Promise<void> {
    this.sent.push(message);
    if (this.sent.length > 200) this.sent.shift();
    this.logger.log(
      `[mail] ${message.template} -> ${message.to} ${JSON.stringify(message.data)}`,
    );
    return Promise.resolve();
  }
}
