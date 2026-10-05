import { pendingCents } from '../../common/money';
import { dbDateToString } from '../../common/time/lima';
import type {
  Booking,
  Customer,
  Departure,
  Document,
  Passenger,
  Payment,
  Series,
  TourRef,
  Waiver,
} from '../../generated/prisma/client';

const u = <T>(value: T | null | undefined): T | undefined => value ?? undefined;

export const toCustomerDto = (c: Customer) => ({
  id: c.id,
  email: c.email,
  firstName: c.firstName,
  lastName: c.lastName,
  phone: u(c.phone),
  country: u(c.country),
  idDocType: u(c.idDocType),
  idDocNumber: u(c.idDocNumber),
  locale: c.locale,
});

export const toPassengerDto = (p: Passenger) => ({
  id: p.id,
  firstName: p.firstName,
  lastName: p.lastName,
  idDocType: u(p.idDocType),
  idDocNumber: u(p.idDocNumber),
  birthDate: p.birthDate ? dbDateToString(p.birthDate) : undefined,
  nationality: u(p.nationality),
  emergencyContactName: u(p.emergencyContactName),
  emergencyContactPhone: u(p.emergencyContactPhone),
});

export const toPaymentDto = (p: Payment, bookingReference?: string) => ({
  id: p.id,
  bookingId: p.bookingId,
  bookingReference,
  provider: p.provider,
  method: p.method,
  kind: p.kind,
  status: p.status,
  currency: p.currency,
  amountCents: p.amountCents,
  refundedCents: p.refundedCents,
  providerRef: p.providerRef,
  failureCode: p.failureCode,
  paidAt: p.paidAt,
  createdAt: p.createdAt,
});

/** Nombre del receptor del comprobante: el de su snapshot, o el respaldo dado. */
const receiverName = (snapshot: unknown, fallback: string): string => {
  const name = (snapshot as { name?: unknown } | null)?.name;
  return typeof name === 'string' && name ? name : fallback;
};

export const toDocumentDto = (
  d: Document & { series: Series },
  booking: { reference: string; customerName: string },
) => ({
  id: d.id,
  bookingId: d.bookingId,
  bookingReference: booking.reference,
  customerName: receiverName(d.customerSnapshot, booking.customerName),
  paymentId: d.paymentId,
  docType: d.docType,
  status: d.status,
  series: d.series.prefix,
  number: d.number,
  currency: d.currency,
  totalCents: d.totalCents,
  taxableCents: d.taxableCents,
  igvCents: d.igvCents,
  exchangeRate: d.exchangeRate ? d.exchangeRate.toFixed(4) : null,
  sunatCode: d.sunatCode,
  sunatMessage: d.sunatMessage,
  relatedDocumentId: d.relatedDocumentId,
  hasXml: d.xmlKey !== null,
  hasCdr: d.cdrKey !== null,
  hasPdf: d.pdfKey !== null,
  issuedAt: d.issuedAt,
  voidedAt: d.voidedAt,
});

export const toWaiverDto = (w: Waiver) => ({
  id: w.id,
  bookingId: w.bookingId,
  passengerId: w.passengerId,
  version: w.version,
  legalDocumentId: w.legalDocumentId,
  status: w.status,
  signerName: w.signerName,
  signedAt: w.signedAt,
  hasPdf: w.pdfKey !== null,
});

type SummarySource = Booking & {
  departure: Departure & { tourRef: Pick<TourRef, 'slug' | 'title'> };
  customer: Pick<Customer, 'firstName' | 'lastName'>;
};

export const toBookingSummary = (
  b: SummarySource,
  titles?: Map<string, string>,
) => ({
  id: b.id,
  reference: b.reference,
  status: b.status,
  source: b.source,
  departureId: b.departureId,
  startsAt: b.departure.startsAt,
  tourSlug: b.departure.tourRef.slug,
  tourTitle: titles?.get(b.departure.tourRef.slug) ?? b.departure.tourRef.title,
  customerName: `${b.customer.firstName} ${b.customer.lastName}`,
  adults: b.adults,
  children: b.children,
  currency: b.currency,
  totalCents: b.totalCents,
  paidCents: b.paidCents,
  createdAt: b.createdAt,
});

type FullSource = SummarySource & {
  customer: Customer;
  passengers: Passenger[];
  payments: Payment[];
  documents: (Document & { series: Series })[];
  waivers: Waiver[];
};

export const toBookingDto = (
  b: FullSource,
  extra: { refundDueCents?: number; titles?: Map<string, string> } = {},
) => ({
  ...toBookingSummary(b, extra.titles),
  customer: toCustomerDto(b.customer),
  depositCents: b.depositCents,
  refundedCents: b.refundedCents,
  refundDueCents: extra.refundDueCents ?? 0,
  billing: b.billing,
  notes: b.notes,
  locale: b.locale,
  priceSnapshot: b.priceSnapshot,
  cancellationSnapshot: b.cancellationSnapshot,
  attribution: b.attribution ?? undefined,
  cancelledAt: b.cancelledAt,
  cancelReason: b.cancelReason,
  passengers: b.passengers.map(toPassengerDto),
  payments: b.payments.map((p) => toPaymentDto(p, b.reference)),
  documents: b.documents.map((d) =>
    toDocumentDto(d, {
      reference: b.reference,
      customerName: receiverName(
        b.billing,
        `${b.customer.firstName} ${b.customer.lastName}`,
      ),
    }),
  ),
  waivers: b.waivers.map(toWaiverDto),
});

/** Saldo por pagar; cero si la reserva ya no está vigente. */
export function bookingPending(b: {
  status: string;
  totalCents: number;
  paidCents: number;
  refundedCents: number;
}): number {
  return b.status === 'PENDING_PAYMENT' || b.status === 'CONFIRMED'
    ? pendingCents(b.totalCents, b.paidCents, b.refundedCents)
    : 0;
}
