import {
  bookingAccess,
  bookingCancelled,
  bookingConfirmed,
  bookingCreated,
  bookingExpired,
  bookingRescheduled,
  departureCancelled,
  paymentLink,
} from './booking';
import {
  complaintAnswered,
  complaintReceived,
  complaintStaffAlert,
  contactMessage,
} from './compliance';
import { langOf } from './format';
import {
  buildEmail,
  type EmailContent,
  type Lang,
  type RenderedEmail,
} from './layout';

export type { RenderedEmail } from './layout';

type Builder = (lang: Lang, data: Record<string, unknown>) => EmailContent;

const TEMPLATES = {
  booking_created: bookingCreated,
  booking_confirmed: bookingConfirmed,
  booking_cancelled: bookingCancelled,
  booking_rescheduled: bookingRescheduled,
  booking_expired: bookingExpired,
  booking_access: bookingAccess,
  payment_link: paymentLink,
  departure_cancelled: departureCancelled,
  complaint_received: complaintReceived,
  complaint_answered: complaintAnswered,
  complaint_staff_alert: complaintStaffAlert,
  contact_message: contactMessage,
} satisfies Record<string, Builder>;

export type TemplateName = keyof typeof TEMPLATES;
export const TEMPLATE_NAMES = Object.keys(TEMPLATES) as TemplateName[];

export class UnknownTemplateError extends Error {
  constructor(template: string) {
    super(`Unknown email template "${template}"`);
  }
}

/** Plantillas internas: van al staff, no al cliente, y siempre en español. */
const INTERNAL: TemplateName[] = ['complaint_staff_alert', 'contact_message'];

/**
 * Asunto, texto y HTML de un correo. El idioma sale del `locale` de la reserva
 * (español para `es*`, inglés para el resto); los avisos internos van en español.
 */
export function renderEmail(
  template: string,
  locale: string | undefined | null,
  data: Record<string, unknown>,
): RenderedEmail {
  const builder = (TEMPLATES as Record<string, Builder>)[template];
  if (!builder) throw new UnknownTemplateError(template);
  const lang: Lang = INTERNAL.includes(template as TemplateName)
    ? 'es'
    : // Sin idioma (p. ej. el libro de reclamaciones) se usa español: es el idioma legal del libro.
      locale
      ? langOf(locale)
      : 'es';
  return buildEmail(builder(lang, data), lang);
}
