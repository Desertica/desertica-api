import type { Dispute, Payment, Refund } from '../../generated/prisma/client';
import { toPaymentDto } from '../bookings/booking.mappers';

export { toPaymentDto };

type Ref = { id: string; reference: string };

export const toRefundDto = (
  r: Refund & { payment: Payment & { booking: Ref } },
  requestedBy: string | null = null,
) => ({
  id: r.id,
  paymentId: r.paymentId,
  bookingId: r.payment.bookingId,
  bookingReference: r.payment.booking.reference,
  currency: r.payment.currency,
  amountCents: r.amountCents,
  reason: r.reason,
  status: r.status,
  creditNoteId: r.creditNoteId,
  requestedBy,
  createdAt: r.createdAt,
});

export const toDisputeDto = (
  d: Dispute & { payment: Payment & { booking: Ref } },
) => ({
  id: d.id,
  paymentId: d.paymentId,
  bookingId: d.payment.bookingId,
  bookingReference: d.payment.booking.reference,
  provider: d.provider,
  providerRef: d.providerRef,
  status: d.status,
  reason: d.reason,
  amountCents: d.amountCents,
  currency: d.currency,
  evidenceDueAt: d.evidenceDueAt,
  notes: d.notes,
  createdAt: d.createdAt,
});

export const REFUND_INCLUDE = {
  payment: { include: { booking: { select: { id: true, reference: true } } } },
} as const;
