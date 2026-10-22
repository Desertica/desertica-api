import type { Prisma } from '../../generated/prisma/client';
import type { EmitRequest } from '../billing/billing-client';

/** Motivos de nota de crédito (catálogo 09 SUNAT). A confirmar con el contador. */
export const CREDIT_NOTE_REASON = {
  /** Devolución total. */
  FULL_RETURN: '06',
  /** Disminución en el valor (reembolso parcial). */
  VALUE_DECREASE: '09',
} as const;

export const pad8 = (n: number) => String(n).padStart(8, '0');
export const documentNumber = (series: string, n: number) =>
  `${series}-${pad8(n)}`;

/** Estados de un comprobante que ya no cuentan como emitidos. */
export const INACTIVE_STATUSES = ['VOIDED'] as const;

/** Lo que hay que guardar para poder reenviar la misma petición a billing. */
export type JobPayload = {
  /** Petición completa a billing, fijada al crear: los reintentos mandan lo mismo. */
  emit?: EmitRequest;
  /** Baja: motivo, fecha y ticket de SUNAT cuando ya existe. */
  void?: { reason: string; voidDate: string; ticket?: string };
};

export const asJson = (v: unknown): Prisma.InputJsonValue =>
  JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue;
