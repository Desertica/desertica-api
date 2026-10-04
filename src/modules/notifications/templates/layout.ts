/**
 * Armado común de los correos: cada plantilla describe su contenido como
 * bloques y de ahí salen el texto plano y el HTML, así los dos nunca difieren.
 */
export type Lang = 'es' | 'en';

export type Block =
  | { type: 'p'; text: string }
  | { type: 'facts'; rows: [label: string, value: string][] }
  | { type: 'list'; items: string[] }
  | { type: 'button'; label: string; url: string }
  /** Texto ajeno (respuesta, mensaje del cliente): se muestra citado, con saltos de línea. */
  | { type: 'quote'; text: string };

export interface EmailContent {
  subject: string;
  /** Texto corto que algunos clientes de correo muestran junto al asunto. */
  preheader?: string;
  heading: string;
  blocks: Block[];
  /** Si no se indica, el pie estándar de la empresa. */
  footer?: string;
}

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

const BRAND = '#9a3412';
const INK = '#1c1917';
const MUTED = '#57534e';
const PAPER = '#fafaf9';

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Solo enlaces http(s): un valor raro nunca termina en un `href`. */
export function safeUrl(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`Unsupported link protocol: ${parsed.protocol}`);
  }
  return parsed.toString();
}

const oneLine = (value: string) => value.replace(/[\r\n]+/g, ' ').trim();

const FOOTER: Record<Lang, string> = {
  es: 'Desértica · Tours de desierto en Ica, Huacachina, Paracas y Nazca. Este correo es un aviso de tu reserva; si no la hiciste tú, ignóralo.',
  en: 'Desértica · Desert tours in Ica, Huacachina, Paracas and Nazca. This email is a notice about your booking; if it was not you, please ignore it.',
};

function renderBlockHtml(block: Block): string {
  switch (block.type) {
    case 'p':
      return `<p style="margin:0 0 16px;line-height:1.55">${escapeHtml(block.text)}</p>`;
    case 'list':
      return `<ul style="margin:0 0 16px;padding-left:20px;line-height:1.55">${block.items
        .map((item) => `<li>${escapeHtml(item)}</li>`)
        .join('')}</ul>`;
    case 'facts':
      return `<table role="presentation" style="width:100%;border-collapse:collapse;margin:0 0 16px">${block.rows
        .map(
          ([label, value]) =>
            `<tr><td style="padding:6px 12px 6px 0;color:${MUTED};vertical-align:top;white-space:nowrap">${escapeHtml(label)}</td><td style="padding:6px 0;font-weight:600">${escapeHtml(value)}</td></tr>`,
        )
        .join('')}</table>`;
    case 'button':
      return `<p style="margin:0 0 20px"><a href="${escapeHtml(safeUrl(block.url))}" style="display:inline-block;background:${BRAND};color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:6px;font-weight:600">${escapeHtml(block.label)}</a></p>`;
    case 'quote':
      return `<blockquote style="margin:0 0 16px;padding:8px 14px;border-left:3px solid ${BRAND};color:${INK};background:#ffffff;line-height:1.55">${escapeHtml(block.text).replace(/\r?\n/g, '<br>')}</blockquote>`;
  }
}

function renderBlockText(block: Block): string {
  switch (block.type) {
    case 'p':
      return block.text;
    case 'list':
      return block.items.map((item) => `- ${item}`).join('\n');
    case 'facts':
      return block.rows
        .map(([label, value]) => `${label}: ${value}`)
        .join('\n');
    case 'button':
      return `${block.label}: ${safeUrl(block.url)}`;
    case 'quote':
      return block.text
        .split(/\r?\n/)
        .map((line) => `> ${line}`)
        .join('\n');
  }
}

export function buildEmail(content: EmailContent, lang: Lang): RenderedEmail {
  const footer = content.footer ?? FOOTER[lang];
  const text = [
    content.heading,
    '',
    ...content.blocks.flatMap((b) => [renderBlockText(b), '']),
    '--',
    footer,
    '',
  ].join('\n');
  const preheader = content.preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0">${escapeHtml(content.preheader)}</div>`
    : '';
  const html = `<!doctype html>
<html lang="${lang}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(oneLine(content.subject))}</title></head>
<body style="margin:0;background:${PAPER};color:${INK};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:16px">
${preheader}
<table role="presentation" style="width:100%;border-collapse:collapse"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" style="width:100%;max-width:600px;border-collapse:collapse;background:#ffffff;border:1px solid #e7e5e4;border-radius:8px"><tr><td style="padding:28px 28px 8px">
<p style="margin:0 0 4px;color:${BRAND};font-weight:700;letter-spacing:.04em">DESÉRTICA</p>
<h1 style="margin:0 0 20px;font-size:22px;line-height:1.3">${escapeHtml(content.heading)}</h1>
${content.blocks.map(renderBlockHtml).join('\n')}
</td></tr><tr><td style="padding:16px 28px 24px;border-top:1px solid #e7e5e4;color:${MUTED};font-size:13px;line-height:1.5">${escapeHtml(footer)}</td></tr></table>
</td></tr></table>
</body>
</html>
`;
  return { subject: oneLine(content.subject), text, html };
}
