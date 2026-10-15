import { formatDate, formatDateTime, num, str } from './format';
import type { EmailContent, Lang } from './layout';

type Data = Record<string, unknown>;
type Builder = (lang: Lang, d: Data) => EmailContent;

const pick = (lang: Lang, es: string, en: string) => (lang === 'es' ? es : en);

const KIND: Record<string, [string, string]> = {
  RECLAMO: ['Reclamo', 'Complaint'],
  QUEJA: ['Queja', 'Grievance'],
};
const kindLabel = (lang: Lang, kind: string) =>
  KIND[kind]?.[lang === 'es' ? 0 : 1] ?? kind;

/** Copia al consumidor de su hoja de reclamación (Libro de Reclamaciones). */
export const complaintReceived: Builder = (lang, d) => {
  const n = num(d, 'correlative');
  const code = n === null ? '' : String(n).padStart(6, '0');
  return {
    subject: pick(
      lang,
      `Hoja de reclamación N.º ${code}`,
      `Complaint form no. ${code}`,
    ),
    heading: pick(
      lang,
      'Recibimos tu hoja de reclamación',
      'We received your complaint form',
    ),
    blocks: [
      {
        type: 'p',
        text: pick(
          lang,
          `${str(d, 'consumerName')}, esta es la copia de tu hoja de reclamación del Libro de Reclamaciones de Desértica.`,
          `${str(d, 'consumerName')}, this is the copy of your complaint form from Desértica's Complaints Book.`,
        ),
      },
      {
        type: 'facts',
        rows: [
          [pick(lang, 'Hoja N.º', 'Form no.'), code],
          [pick(lang, 'Tipo', 'Type'), kindLabel(lang, str(d, 'kind'))],
          ...(str(d, 'createdAt')
            ? [
                [
                  pick(lang, 'Fecha', 'Date'),
                  formatDateTime(str(d, 'createdAt'), lang),
                ] as [string, string],
              ]
            : []),
          ...(str(d, 'dueAt')
            ? [
                [
                  pick(
                    lang,
                    'Te responderemos antes del',
                    'We will answer before',
                  ),
                  formatDate(str(d, 'dueAt'), lang),
                ] as [string, string],
              ]
            : []),
        ],
      },
      {
        type: 'p',
        text: pick(lang, 'Bien contratado:', 'Contracted good or service:'),
      },
      { type: 'quote', text: str(d, 'description') },
      { type: 'p', text: pick(lang, 'Detalle:', 'Details:') },
      { type: 'quote', text: str(d, 'detail') },
      {
        type: 'p',
        text: pick(lang, 'Pedido del consumidor:', 'Consumer request:'),
      },
      { type: 'quote', text: str(d, 'request') },
    ],
    footer: pick(
      lang,
      'Desértica · Libro de Reclamaciones. La formulación del reclamo no impide acudir a otras vías de solución de controversias ni es requisito previo para interponer una denuncia ante el INDECOPI.',
      'Desértica · Complaints Book. Filing a complaint does not prevent you from using other dispute resolution channels nor is it a prerequisite to filing a claim with INDECOPI.',
    ),
  };
};

export const complaintAnswered: Builder = (lang, d) => {
  const n = num(d, 'correlative');
  const code = n === null ? '' : String(n).padStart(6, '0');
  return {
    subject: pick(
      lang,
      `Respuesta a tu hoja de reclamación N.º ${code}`,
      `Answer to your complaint form no. ${code}`,
    ),
    heading: pick(
      lang,
      'Respondimos tu reclamación',
      'We answered your complaint',
    ),
    blocks: [
      {
        type: 'p',
        text: pick(
          lang,
          `${str(d, 'consumerName')}, esta es nuestra respuesta a tu hoja N.º ${code}:`,
          `${str(d, 'consumerName')}, this is our answer to your form no. ${code}:`,
        ),
      },
      { type: 'quote', text: str(d, 'answer') },
      ...(str(d, 'answeredAt')
        ? [
            {
              type: 'p' as const,
              text: pick(
                lang,
                `Respondido el ${formatDate(str(d, 'answeredAt'), lang)}.`,
                `Answered on ${formatDate(str(d, 'answeredAt'), lang)}.`,
              ),
            },
          ]
        : []),
    ],
  };
};

/** Aviso interno: siempre en español. */
export const complaintStaffAlert: Builder = (_lang, d) => {
  const n = num(d, 'correlative');
  const code = n === null ? '' : String(n).padStart(6, '0');
  return {
    subject: `Nuevo reclamo N.º ${code}`,
    heading: 'Nuevo reclamo en el Libro de Reclamaciones',
    blocks: [
      {
        type: 'facts',
        rows: [
          ['Hoja N.º', code],
          ...(str(d, 'dueAt')
            ? [
                ['Responder antes del', formatDate(str(d, 'dueAt'), 'es')] as [
                  string,
                  string,
                ],
              ]
            : []),
        ],
      },
      {
        type: 'p',
        text: 'Ábrelo en el backoffice para verlo y responderlo dentro del plazo.',
      },
    ],
    footer: 'Aviso interno de Desértica.',
  };
};

/** Aviso interno: mensaje del formulario de contacto. Siempre en español. */
export const contactMessage: Builder = (_lang, d) => ({
  subject:
    `Mensaje de contacto de ${str(d, 'name').replace(/[\r\n]+/g, ' ')}`.slice(
      0,
      120,
    ),
  heading: 'Nuevo mensaje de contacto',
  blocks: [
    {
      type: 'facts',
      rows: [
        ['Nombre', str(d, 'name')],
        ['Correo', str(d, 'email')],
        ...(str(d, 'whatsapp')
          ? [['WhatsApp', str(d, 'whatsapp')] as [string, string]]
          : []),
        ...(str(d, 'country')
          ? [['País', str(d, 'country')] as [string, string]]
          : []),
      ],
    },
    { type: 'quote', text: str(d, 'message') },
    {
      type: 'p',
      text: 'Responde a este correo para contestarle directamente.',
    },
  ],
  footer: 'Aviso interno de Desértica.',
});
