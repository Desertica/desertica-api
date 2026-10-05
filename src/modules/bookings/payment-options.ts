import { pendingCents } from '../../common/money';

export type PaymentKindOption = 'FULL' | 'DEPOSIT' | 'BALANCE';
export interface PaymentOption {
  provider: 'STRIPE' | 'CULQI';
  kinds: PaymentKindOption[];
}

/**
 * Pasarelas y tipos de pago disponibles para una reserva. Es solo una regla de
 * moneda y saldo: no consulta ninguna pasarela. Stripe cobra solo USD; Culqi
 * USD o PEN. Sin saldo (pagada, cancelada o vencida) no hay opciones.
 */
export function paymentOptionsFor(b: {
  status: string;
  currency: string;
  totalCents: number;
  depositCents: number | null;
  paidCents: number;
  refundedCents: number;
}): PaymentOption[] {
  if (b.status !== 'PENDING_PAYMENT' && b.status !== 'CONFIRMED') return [];
  if (pendingCents(b.totalCents, b.paidCents, b.refundedCents) <= 0) return [];
  const net = b.paidCents - b.refundedCents;
  const kinds: PaymentKindOption[] =
    net > 0 ? ['BALANCE'] : b.depositCents !== null ? ['DEPOSIT'] : ['FULL'];
  return [
    ...(b.currency === 'USD' ? [{ provider: 'STRIPE' as const, kinds }] : []),
    { provider: 'CULQI' as const, kinds },
  ];
}
