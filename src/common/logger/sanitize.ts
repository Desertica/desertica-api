/**
 * Lo que va a los logs no debe llevar secretos ni datos personales: los
 * enlaces públicos llevan un token en la ruta (`/public/waivers/<token>`) y los
 * errores de SMTP o de Prisma pueden repetir un correo o los valores enviados.
 */

/** Segmentos de ruta que son un token de un solo cliente. */
const TOKEN_PATHS = /(\/public\/(?:waivers|payment-links|holds)\/)[^/?#]+/g;

/** Parámetros de consulta que nunca deben registrarse. */
const SECRET_PARAMS =
  /([?&](?:token|key|secret|code|password|signature)=)[^&#]*/gi;

export function redactUrl(url: string): string {
  return url
    .replace(TOKEN_PATHS, '$1[redacted]')
    .replace(SECRET_PARAMS, '$1[redacted]');
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** Texto de error sin direcciones de correo. */
export function redactEmails(text: string): string {
  return text.replace(EMAIL, '[email]');
}

/**
 * Descripción de un error para el log. De los errores de Prisma se descarta el
 * mensaje (repite los datos de la consulta: nombres, documentos, correos) y se
 * deja el nombre, el código y las líneas de la traza; del resto, el mensaje
 * sin correos.
 */
export function describeError(error: unknown): string {
  if (!(error instanceof Error)) return 'non-error thrown';
  const frames = (error.stack ?? '')
    .split('\n')
    .filter((line) => /^\s+at /.test(line))
    .join('\n');
  const code = (error as { code?: unknown }).code;
  const suffix = typeof code === 'string' ? ` [${code}]` : '';
  const name =
    error.name === 'Error' ? error.constructor.name || error.name : error.name;
  const message = name.startsWith('PrismaClient')
    ? '(message withheld: it can contain request data)'
    : redactEmails(error.message);
  return `${name}${suffix}: ${message}\n${frames}`;
}
