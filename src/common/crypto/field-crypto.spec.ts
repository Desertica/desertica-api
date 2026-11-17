import { randomBytes } from 'node:crypto';
import { decryptField, encryptField, isEncrypted } from './field-crypto';

describe('field-crypto', () => {
  const key = randomBytes(32).toString('base64');

  it('round-trips and never stores the plain text', () => {
    const stored = encryptField(key, 'Asma leve — usa inhalador');
    expect(isEncrypted(stored)).toBe(true);
    expect(stored).not.toContain('Asma');
    expect(decryptField(key, stored)).toBe('Asma leve — usa inhalador');
  });

  it('uses a fresh IV each time', () => {
    expect(encryptField(key, 'x')).not.toBe(encryptField(key, 'x'));
  });

  it('passes legacy plain values through', () => {
    expect(decryptField(key, 'Alergia')).toBe('Alergia');
  });

  it('rejects a tampered value or the wrong key', () => {
    const stored = encryptField(key, 'Diabetes');
    const parts = stored.split(':');
    parts[4] = Buffer.from('Diabetez').toString('base64');
    expect(() => decryptField(key, parts.join(':'))).toThrow();
    expect(() =>
      decryptField(randomBytes(32).toString('base64'), stored),
    ).toThrow();
  });

  it('rejects a key that is not 32 bytes', () => {
    expect(() =>
      encryptField(Buffer.from('short').toString('base64'), 'x'),
    ).toThrow();
  });
});
