import { formatDateTime, formatMoney, num, str, strList } from './format';
import type { EmailContent, Lang } from './layout';

type Data = Record<string, unknown>;
type Builder = (lang: Lang, d: Data) => EmailContent;

const pick = (lang: Lang, es: string, en: string) => (lang === 'es' ? es : en);

/** Tour: el título según el idioma si el envío lo trae; si no, el slug. */
const tourOf = (d: Data) => str(d, 'tourTitle') || str(d, 'tourSlug');

function tripFacts(lang: Lang, d: Data): [string, string][] {
  const rows: [string, string][] = [
    [pick(lang, 'Reserva', 'Booking'), str(d, 'reference')],
    [pick(lang, 'Tour', 'Tour'), tourOf(d)],
  ];
  const startsAt = str(d, 'startsAt');
  if (startsAt)
    rows.push([
      pick(lang, 'Salida', 'Departure'),
      formatDateTime(startsAt, lang),
    ]);
  return rows;
}

function money(lang: Lang, d: Data, key: string): string | null {
  const cents = num(d, key);
  const currency = str(d, 'currency');
  return cents === null || !currency
    ? null
    : formatMoney(cents, currency, lang);
}

export const bookingCreated: Builder = (lang, d) => {
  const waiverUrls = strList(d, 'waiverUrls');
  const total = money(lang, d, 'totalCents');
  const pending =
    (num(d, 'pendingCents') ?? 0) > 0 ? money(lang, d, 'pendingCents') : null;
  const facts = tripFacts(lang, d);
  if (total) facts.push([pick(lang, 'Total', 'Total'), total]);
  if (pending) facts.push([pick(lang, 'Por pagar', 'Balance due'), pending]);
  return {
    subject: pick(
      lang,
      `Recibimos tu reserva ${str(d, 'reference')}`,
      `We received your booking ${str(d, 'reference')}`,
    ),
    preheader: pick(
      lang,
      'Guarda este correo: tiene el enlace a tu reserva.',
      'Keep this email: it has the link to your booking.',
    ),
    heading: pick(lang, 'Recibimos tu reserva', 'We received your booking'),
    blocks: [
      {
        type: 'p',
        text: pick(
          lang,
          'Gracias por reservar con Desértica. Estos son los datos de tu reserva:',
          'Thank you for booking with Desértica. Here are your booking details:',
        ),
      },
      { type: 'facts', rows: facts },
      ...(pending
        ? [
            {
              type: 'p' as const,
              text: pick(
                lang,
                'Tu cupo queda reservado por tiempo limitado: completa el pago desde el enlace para confirmarlo.',
                'Your seats are held for a limited time: complete the payment from the link to confirm them.',
              ),
            },
          ]
        : []),
      ...(str(d, 'bookingUrl')
        ? [
            {
              type: 'button' as const,
              label: pick(lang, 'Ver mi reserva', 'View my booking'),
              url: str(d, 'bookingUrl'),
            },
          ]
        : []),
      ...(waiverUrls.length > 0
        ? [
            {
              type: 'p' as const,
              text: pick(
                lang,
                'Cada pasajero debe firmar el descargo de responsabilidad antes de la salida:',
                'Every passenger must sign the liability waiver before the departure:',
              ),
            },
            {
              type: 'list' as const,
              items: waiverUrls.map(
                (url, i) =>
                  `${pick(lang, 'Pasajero', 'Passenger')} ${i + 1}: ${url}`,
              ),
            },
          ]
        : []),
    ],
  };
};

export const bookingConfirmed: Builder = (lang, d) => {
  const facts = tripFacts(lang, d);
  const total = money(lang, d, 'totalCents');
  const paid = money(lang, d, 'paidCents');
  if (total) facts.push([pick(lang, 'Total', 'Total'), total]);
  if (paid) facts.push([pick(lang, 'Pagado', 'Paid'), paid]);
  return {
    subject: pick(
      lang,
      `Reserva confirmada ${str(d, 'reference')}`,
      `Booking confirmed ${str(d, 'reference')}`,
    ),
    heading: pick(
      lang,
      '¡Tu reserva está confirmada!',
      'Your booking is confirmed!',
    ),
    blocks: [
      {
        type: 'p',
        text: pick(
          lang,
          'Recibimos tu pago y tu cupo está asegurado. Te esperamos:',
          'We received your payment and your seats are secured. See you there:',
        ),
      },
      { type: 'facts', rows: facts },
    ],
  };
};

export const bookingCancelled: Builder = (lang, d) => {
  const refund = num(d, 'refundDueCents') ?? 0;
  const refundText = money(lang, d, 'refundDueCents');
  return {
    subject: pick(
      lang,
      `Reserva cancelada ${str(d, 'reference')}`,
      `Booking cancelled ${str(d, 'reference')}`,
    ),
    heading: pick(
      lang,
      'Tu reserva fue cancelada',
      'Your booking was cancelled',
    ),
    blocks: [
      { type: 'facts', rows: tripFacts(lang, d) },
      ...(str(d, 'reason')
        ? [
            {
              type: 'p' as const,
              text: pick(lang, 'Motivo:', 'Reason:'),
            },
            { type: 'quote' as const, text: str(d, 'reason') },
          ]
        : []),
      {
        type: 'p',
        text:
          refund > 0 && refundText
            ? pick(
                lang,
                `Te corresponde un reembolso de ${refundText}. Lo procesaremos al medio de pago original; el banco puede tardar unos días en reflejarlo.`,
                `You are due a refund of ${refundText}. We will process it to the original payment method; your bank may take a few days to show it.`,
              )
            : pick(
                lang,
                'Esta cancelación no genera reembolso.',
                'This cancellation does not generate a refund.',
              ),
      },
      {
        type: 'p',
        text: pick(
          lang,
          '¿Dudas? Responde a este correo o escríbenos por WhatsApp.',
          'Questions? Reply to this email or message us on WhatsApp.',
        ),
      },
    ],
  };
};

export const bookingRescheduled: Builder = (lang, d) => {
  const adjustment = d.adjustment as {
    type?: string;
    amountCents?: number;
  } | null;
  const currency = str(d, 'currency');
  const amount =
    adjustment && typeof adjustment.amountCents === 'number' && currency
      ? formatMoney(adjustment.amountCents, currency, lang)
      : null;
  const note =
    adjustment?.type === 'CHARGE' && amount
      ? pick(
          lang,
          `La nueva salida cuesta ${amount} más; te enviaremos el enlace para pagar la diferencia.`,
          `The new departure costs ${amount} more; we will send you a link to pay the difference.`,
        )
      : adjustment?.type === 'REFUND' && amount
        ? pick(
            lang,
            `La nueva salida cuesta ${amount} menos; te devolveremos la diferencia.`,
            `The new departure costs ${amount} less; we will refund the difference.`,
          )
        : pick(
            lang,
            'El precio de tu reserva no cambia.',
            'Your booking price does not change.',
          );
  return {
    subject: pick(
      lang,
      `Reserva reprogramada ${str(d, 'reference')}`,
      `Booking rescheduled ${str(d, 'reference')}`,
    ),
    heading: pick(
      lang,
      'Reprogramamos tu reserva',
      'We rescheduled your booking',
    ),
    blocks: [
      {
        type: 'p',
        text: pick(
          lang,
          'Tu reserva tiene una nueva fecha:',
          'Your booking has a new date:',
        ),
      },
      { type: 'facts', rows: tripFacts(lang, d) },
      ...(str(d, 'reason')
        ? [{ type: 'quote' as const, text: str(d, 'reason') }]
        : []),
      { type: 'p', text: note },
    ],
  };
};

export const bookingExpired: Builder = (lang, d) => ({
  subject: pick(
    lang,
    `Tu reserva ${str(d, 'reference')} venció`,
    `Your booking ${str(d, 'reference')} expired`,
  ),
  heading: pick(lang, 'Tu reserva venció', 'Your booking expired'),
  blocks: [
    { type: 'facts', rows: tripFacts(lang, d) },
    {
      type: 'p',
      text: pick(
        lang,
        'No recibimos el pago dentro del plazo, así que liberamos los cupos. Si todavía quieres ir, puedes hacer una nueva reserva en nuestro sitio.',
        'We did not receive the payment in time, so we released the seats. If you still want to join, you can make a new booking on our website.',
      ),
    },
  ],
});

export const bookingAccess: Builder = (lang, d) => ({
  subject: pick(
    lang,
    `Tu enlace para ver la reserva ${str(d, 'reference')}`,
    `Your link to view booking ${str(d, 'reference')}`,
  ),
  heading: pick(lang, 'Acceso a tu reserva', 'Access to your booking'),
  blocks: [
    {
      type: 'p',
      text: pick(
        lang,
        'Pediste ver tu reserva. Usa este botón; el enlace es personal, no lo compartas.',
        'You asked to view your booking. Use this button; the link is personal, please do not share it.',
      ),
    },
    {
      type: 'button',
      label: pick(lang, 'Ver mi reserva', 'View my booking'),
      url: str(d, 'bookingUrl'),
    },
    {
      type: 'p',
      text: pick(
        lang,
        'Si no fuiste tú, ignora este correo: nadie puede ver tu reserva sin el enlace.',
        'If it was not you, ignore this email: nobody can see your booking without the link.',
      ),
    },
  ],
});

export const paymentLink: Builder = (lang, d) => {
  const kind = str(d, 'kind');
  const kindText =
    kind === 'DEPOSIT'
      ? pick(lang, 'depósito', 'deposit')
      : kind === 'BALANCE'
        ? pick(lang, 'saldo', 'balance')
        : pick(lang, 'pago', 'payment');
  const amount = money(lang, d, 'amountCents');
  const expiresAt = str(d, 'expiresAt');
  return {
    subject: pick(
      lang,
      `Enlace de pago de tu reserva ${str(d, 'reference')}`,
      `Payment link for your booking ${str(d, 'reference')}`,
    ),
    heading: pick(lang, 'Paga tu reserva', 'Pay for your booking'),
    blocks: [
      {
        type: 'facts',
        rows: [
          ...tripFacts(lang, d),
          ...(amount
            ? [
                [
                  pick(
                    lang,
                    `Monto del ${kindText}`,
                    `Amount of the ${kindText}`,
                  ),
                  amount,
                ] as [string, string],
              ]
            : []),
          ...(expiresAt
            ? [
                [
                  pick(lang, 'Vence', 'Expires'),
                  formatDateTime(expiresAt, lang),
                ] as [string, string],
              ]
            : []),
        ],
      },
      {
        type: 'button',
        label: pick(lang, 'Pagar ahora', 'Pay now'),
        url: str(d, 'paymentUrl'),
      },
      {
        type: 'p',
        text: pick(
          lang,
          'El enlace sirve una sola vez y es personal.',
          'The link works once and is personal.',
        ),
      },
    ],
  };
};

/** Salida cancelada por la empresa cuando el cliente elige qué hacer (`CLIENT_CHOICE`). */
export const departureCancelled: Builder = (lang, d) => ({
  subject: pick(
    lang,
    `Cancelamos la salida de tu reserva ${str(d, 'reference')}`,
    `We cancelled the departure of your booking ${str(d, 'reference')}`,
  ),
  heading: pick(lang, 'Cancelamos tu salida', 'We cancelled your departure'),
  blocks: [
    {
      type: 'p',
      text: pick(
        lang,
        'Lamentamos avisarte que la salida de tu reserva fue cancelada por nosotros:',
        'We are sorry to let you know that the departure of your booking was cancelled by us:',
      ),
    },
    { type: 'facts', rows: tripFacts(lang, d) },
    ...(str(d, 'reason')
      ? [{ type: 'quote' as const, text: str(d, 'reason') }]
      : []),
    {
      type: 'p',
      text: pick(
        lang,
        'Tú decides: puedes pasar a otra fecha sin costo o recibir el reembolso completo. Responde a este correo o escríbenos por WhatsApp indicando tu elección.',
        'It is your choice: you can move to another date at no cost or receive a full refund. Reply to this email or message us on WhatsApp with your choice.',
      ),
    },
  ],
});
