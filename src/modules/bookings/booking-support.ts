import { UnprocessableEntityException } from '@nestjs/common';
import { createHash, randomBytes, randomInt } from 'node:crypto';
import type { Prisma } from '../../generated/prisma/client';
import type { BillingDto } from './dto/booking.dto';

/** Valor JSON plano (sin clases ni fechas) para columnas `Json`. */
export const toJson = (value: unknown): Prisma.InputJsonValue =>
  JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;

/** Sin 0/O, 1/I/L ni U: se dicta por teléfono. */
const REFERENCE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Referencia pública corta, p. ej. `DST-7K4Q9M`. */
export function generateReference(): string {
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += REFERENCE_ALPHABET[randomInt(REFERENCE_ALPHABET.length)];
  }
  return `DST-${code}`;
}

/** Token opaco para cliente (acceso, bloqueo, enlace de pago, descargo). */
export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

const DOC_RULES: Record<string, RegExp> = {
  DNI: /^\d{8}$/,
  RUC: /^\d{11}$/,
  CE: /^[A-Za-z0-9]{9,12}$/,
  PASSPORT: /^[A-Za-z0-9]{6,12}$/,
};

export function isValidDocument(type: string, number: string): boolean {
  return (DOC_RULES[type] ?? /^.+$/).test(number);
}

/**
 * Datos del receptor del comprobante. Factura: RUC de 11 dígitos y dirección.
 * Boleta: cualquier documento válido salvo RUC.
 */
export function validateBilling(billing: BillingDto): void {
  if (!isValidDocument(billing.idDocType, billing.idDocNumber)) {
    throw new UnprocessableEntityException(
      `billing.idDocNumber is not a valid ${billing.idDocType}`,
    );
  }
  if (billing.docType === 'FACTURA') {
    if (billing.idDocType !== 'RUC') {
      throw new UnprocessableEntityException('A FACTURA requires a RUC');
    }
    if (!billing.address) {
      throw new UnprocessableEntityException('A FACTURA requires an address');
    }
  } else if (billing.idDocType === 'RUC') {
    throw new UnprocessableEntityException('Use docType FACTURA with a RUC');
  }
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
