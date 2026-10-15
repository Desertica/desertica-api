import type { PaymentStatus } from '../../generated/prisma/client';

/** Estados de un pago que ya acreditó dinero: repetir el evento no hace nada. */
export const SETTLED: PaymentStatus[] = [
  'SUCCEEDED',
  'PARTIALLY_REFUNDED',
  'REFUNDED',
  'DISPUTED',
];

/** Lo que hay que hacer cuando la transacción de un evento ya se confirmó. */
export interface Effects {
  error?: string;
  paymentId?: string;
  confirmedBookingId?: string;
  /** Pago que acaba de quedar acreditado (para emitir su comprobante). */
  settledPaymentId?: string;
  refundIds: string[];
  alerts: { code: string; data: Record<string, unknown>; bookingId?: string }[];
}

export const newEffects = (): Effects => ({ refundIds: [], alerts: [] });
