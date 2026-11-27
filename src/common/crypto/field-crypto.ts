import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Cifrado de campos sensibles en la base (AES-256-GCM). El valor guardado es
 * `enc:v1:<iv>:<tag>:<cifrado>` en base64; un valor sin ese prefijo es un dato
 * anterior al cifrado y se devuelve tal cual hasta que el arranque lo cifre.
 */
const PREFIX = 'enc:v1:';

function key(keyBase64: string): Buffer {
  const k = Buffer.from(keyBase64, 'base64');
  if (k.length !== 32) throw new Error('DATA_ENCRYPTION_KEY must be 32 bytes');
  return k;
}

export function isEncrypted(value: string): boolean {
  return value.startsWith(PREFIX);
}

export function encryptField(keyBase64: string, plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(keyBase64), iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return `${PREFIX}${[iv, cipher.getAuthTag(), data].map((b) => b.toString('base64')).join(':')}`;
}

export function decryptField(keyBase64: string, stored: string): string {
  if (!isEncrypted(stored)) return stored;
  const [iv, tag, data] = stored
    .slice(PREFIX.length)
    .split(':')
    .map((p) => Buffer.from(p, 'base64'));
  const decipher = createDecipheriv('aes-256-gcm', key(keyBase64), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString(
    'utf8',
  );
}
