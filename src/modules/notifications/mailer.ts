/** Correo saliente. El driver real (SMTP/API) es de una ola posterior. */
export interface MailMessage {
  to: string;
  /** Identificador de la plantilla: `booking_created`, `booking_cancelled`, … */
  template: string;
  locale?: string;
  /** Variables de la plantilla (incluye enlaces con tokens). */
  data: Record<string, unknown>;
}

export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

export const MAILER = Symbol('MAILER');
