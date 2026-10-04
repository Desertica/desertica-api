/** Correo saliente. Drivers: `LogMailer` (desarrollo y pruebas) y `SmtpMailer`. */
export interface MailMessage {
  to: string;
  /** Identificador de la plantilla: `booking_created`, `booking_cancelled`, … */
  template: string;
  locale?: string;
  /** A quién responde el destinatario (p. ej. el cliente en un aviso interno). */
  replyTo?: string;
  /** Variables de la plantilla (incluye enlaces con tokens). */
  data: Record<string, unknown>;
}

export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

export const MAILER = Symbol('MAILER');
