import { Logger, type OnModuleDestroy } from '@nestjs/common';
import { createTransport, type Transporter } from 'nodemailer';
import type { Mailer, MailMessage } from './mailer';
import { renderEmail } from './templates';

export interface SmtpConfig {
  host: string;
  port: number;
  /** TLS implícito (puerto 465). */
  secure: boolean;
  /** Exige STARTTLS cuando no hay TLS implícito. */
  requireTls: boolean;
  user?: string;
  password?: string;
  from: string;
  replyTo?: string;
}

/**
 * Driver SMTP (nodemailer). Sirve el relay de Google Workspace
 * (`smtp-relay.gmail.com:587` con STARTTLS) o cualquier otro servidor SMTP.
 * Renderiza la plantilla (texto y HTML) y la envía; un error de envío se
 * propaga para que `NotificationsService` lo deje como `FAILED`.
 */
export class SmtpMailer implements Mailer, OnModuleDestroy {
  private readonly logger = new Logger(SmtpMailer.name);
  private readonly transport: Transporter;

  constructor(
    private readonly config: SmtpConfig,
    transport?: Transporter,
  ) {
    this.transport =
      transport ??
      createTransport({
        host: config.host,
        port: config.port,
        secure: config.secure,
        requireTLS: !config.secure && config.requireTls,
        auth:
          config.user && config.password
            ? { user: config.user, pass: config.password }
            : undefined,
        // Pocas conexiones reutilizadas; un servidor mudo no cuelga una petición.
        pool: true,
        maxConnections: 3,
        maxMessages: 100,
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 20_000,
        tls: { minVersion: 'TLSv1.2' },
      });
  }

  async send(message: MailMessage): Promise<void> {
    const rendered = renderEmail(
      message.template,
      message.locale,
      message.data,
    );
    const info = await this.transport.sendMail({
      from: this.config.from,
      to: message.to,
      replyTo: message.replyTo ?? (this.config.replyTo || undefined),
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
      headers: { 'Auto-Submitted': 'auto-generated' },
    });
    this.logger.log(
      `Sent ${message.template} (${(info as { messageId?: string }).messageId ?? 'no id'})`,
    );
  }

  onModuleDestroy(): void {
    this.transport.close();
  }
}
