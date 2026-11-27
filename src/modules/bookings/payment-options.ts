import type { ConfigService } from '@nestjs/config';
import { pendingCents } from '../../common/money';
import type { EnvVars } from '../../config/env.validation';

export type PaymentKindOption = 'FULL' | 'DEPOSIT' | 'BALANCE';
export interface PaymentOption {
  provider: 'STRIPE' | 'CULQI';
  kinds: PaymentKindOption[];
}

/**
 * Pasarelas y tipos de pago disponibles para una reserva. Es solo una regla de
 * moneda y saldo: no consulta ninguna pasarela. Stripe cobra solo USD y solo
 * se ofrece si `stripe` (ver `stripeEnabled`); Culqi USD o PEN. Sin saldo
 * (pagada, cancelada o vencida) no hay opciones.
 */
export function paymentOptionsFor(
  b: {
    status: string;
    currency: string;
    totalCents: number;
    depositCents: number | null;
    paidCents: number;
    refundedCents: number;
  },
  stripe = false,
): PaymentOption[] {
  if (b.status !== 'PENDING_PAYMENT' && b.status !== 'CONFIRMED') return [];
  if (pendingCents(b.totalCents, b.paidCents, b.refundedCents) <= 0) return [];
  const net = b.paidCents - b.refundedCents;
  const kinds: PaymentKindOption[] =
    net > 0 ? ['BALANCE'] : b.depositCents !== null ? ['DEPOSIT'] : ['FULL'];
  return [
    ...(stripe && b.currency === 'USD'
      ? [{ provider: 'STRIPE' as const, kinds }]
      : []),
    { provider: 'CULQI' as const, kinds },
  ];
}

/** Stripe se apaga dejando vacía `STRIPE_SECRET_KEY` (la pasarela simulada siempre lo ofrece). */
export function stripeEnabled(config: ConfigService<EnvVars, true>): boolean {
  return (
    config.get('PAYMENT_GATEWAY_MODE', { infer: true }) === 'fake' ||
    !!config.get('STRIPE_SECRET_KEY', { infer: true })
  );
}
