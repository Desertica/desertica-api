export interface RefundablePayment {
  id: string;
  /** Pagado menos lo ya reembolsado y lo que está pendiente de reembolsar. */
  refundableCents: number;
}

export interface RefundAllocation {
  paymentId: string;
  amountCents: number;
}

/**
 * Reparte un reembolso entre los pagos de una reserva, del más reciente al más
 * antiguo (la pasarela devuelve contra el cobro original). La lista debe venir
 * ordenada del más antiguo al más reciente. Devuelve `null` si no alcanza.
 */
export function allocateRefund(
  payments: RefundablePayment[],
  amountCents: number,
): RefundAllocation[] | null {
  let remaining = amountCents;
  const result: RefundAllocation[] = [];
  for (const payment of [...payments].reverse()) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, payment.refundableCents);
    if (take > 0) {
      result.push({ paymentId: payment.id, amountCents: take });
      remaining -= take;
    }
  }
  return remaining === 0 ? result : null;
}
