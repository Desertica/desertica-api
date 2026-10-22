import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Enlaces firmados de corta vida para descargar un archivo sin cabeceras (un
 * enlace de correo o un `<a href>` no pueden mandar `X-Booking-Token`). La
 * firma es HMAC-SHA256 de `recurso:vencimiento` con una clave derivada del
 * secreto del API (no se reutiliza el secreto de los JWT tal cual).
 */
const key = (secret: string) =>
  createHmac('sha256', secret).update('desertica:signed-link').digest();

export function signLink(
  secret: string,
  resource: string,
  expiresAtSeconds: number,
): string {
  return createHmac('sha256', key(secret))
    .update(`${resource}:${expiresAtSeconds}`)
    .digest('hex');
}

export function verifyLink(
  secret: string,
  resource: string,
  expiresAtSeconds: number,
  signature: string,
  nowMs = Date.now(),
): boolean {
  if (!Number.isInteger(expiresAtSeconds) || expiresAtSeconds * 1000 <= nowMs) {
    return false;
  }
  const expected = Buffer.from(signLink(secret, resource, expiresAtSeconds));
  const received = Buffer.from(signature);
  return (
    expected.length === received.length && timingSafeEqual(expected, received)
  );
}

/** URL absoluta de descarga pública del PDF de un comprobante, válida `ttlSeconds`. */
export function publicDocumentUrl(
  apiBaseUrl: string,
  secret: string,
  documentId: string,
  ttlSeconds = 3600,
  nowMs = Date.now(),
): string {
  const exp = Math.floor(nowMs / 1000) + ttlSeconds;
  const sig = signLink(secret, `document:${documentId}`, exp);
  return `${apiBaseUrl.replace(/\/$/, '')}/public/documents/${documentId}/pdf?exp=${exp}&sig=${sig}`;
}
