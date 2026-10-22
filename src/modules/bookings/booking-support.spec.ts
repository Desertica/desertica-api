import { UnprocessableEntityException } from '@nestjs/common';
import {
  generateReference,
  generateToken,
  isValidDocument,
  normalizeEmail,
  sha256,
  validateBilling,
} from './booking-support';

describe('references and tokens', () => {
  it('builds DST-XXXXXX references without ambiguous characters', () => {
    for (let i = 0; i < 200; i++) {
      expect(generateReference()).toMatch(/^DST-[2-9A-HJKMNP-TV-Z]{6}$/);
    }
  });
  it('generates unguessable distinct tokens and hashes them', () => {
    const a = generateToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateToken()).not.toBe(a);
    expect(sha256(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256(a)).toBe(sha256(a));
  });
  it('normalizes emails', () => {
    expect(normalizeEmail('  Ana@Example.COM ')).toBe('ana@example.com');
  });
});

describe('documents and billing', () => {
  it('validates each document type', () => {
    expect(isValidDocument('DNI', '12345678')).toBe(true);
    expect(isValidDocument('DNI', '1234567')).toBe(false);
    expect(isValidDocument('RUC', '20123456789')).toBe(true);
    expect(isValidDocument('RUC', '2012345678')).toBe(false);
    expect(isValidDocument('PASSPORT', 'AB123456')).toBe(true);
    expect(isValidDocument('CE', 'abc')).toBe(false);
  });

  const boleta = {
    docType: 'BOLETA' as const,
    name: 'Ana',
    idDocType: 'DNI' as const,
    idDocNumber: '12345678',
  };
  const factura = {
    docType: 'FACTURA' as const,
    name: 'ACME SAC',
    idDocType: 'RUC' as const,
    idDocNumber: '20123456789',
    address: 'Av. 1',
  };

  it('accepts valid boleta and factura', () => {
    expect(() => validateBilling(boleta)).not.toThrow();
    expect(() => validateBilling(factura)).not.toThrow();
  });
  it('rejects inconsistent combinations', () => {
    const bad = (b: object) =>
      expect(() => validateBilling(b as never)).toThrow(
        UnprocessableEntityException,
      );
    bad({ ...boleta, idDocNumber: '123' });
    bad({ ...factura, idDocType: 'DNI', idDocNumber: '12345678' });
    bad({ ...factura, address: undefined });
    bad({ ...boleta, idDocType: 'RUC', idDocNumber: '20123456789' });
  });
});
