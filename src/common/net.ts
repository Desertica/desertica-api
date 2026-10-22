import { isIP } from 'node:net';

/**
 * Forma canónica de una IP para compararla: sin el prefijo IPv4-mapped de
 * IPv6 (`::ffff:1.2.3.4`) y en minúsculas. `null` si no es una IP válida.
 */
export function normalizeIp(raw: string | undefined | null): string | null {
  if (!raw) return null;
  let value = raw.trim().toLowerCase();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(value);
  if (mapped) value = mapped[1];
  return isIP(value) ? value : null;
}
