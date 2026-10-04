/**
 * Cliente tipado de `desertica-billing`, a partir de `openapi/billing.yaml`.
 * Hay una implementación HTTP (`HttpBillingClient`) y una falsa
 * (`FakeBillingClient`) que sigue el mismo contrato.
 */

export type BillingDocType =
  'BOLETA' | 'FACTURA' | 'NOTA_CREDITO' | 'NOTA_DEBITO';
export type BillingDocStatus =
  'PENDING' | 'ISSUED' | 'ACCEPTED' | 'REJECTED' | 'VOIDED' | 'ERROR';
export type BillingFileKind = 'xml' | 'cdr' | 'pdf';

export interface BillingCustomer {
  idDocType: 'DNI' | 'CE' | 'PASSPORT' | 'RUC';
  idDocNumber: string;
  name: string;
  address?: string;
  email?: string;
}

export interface BillingItem {
  description: string;
  quantity: number;
  /** Con IGV incluido. */
  unitPriceCents: number;
  /** Con IGV incluido. */
  totalCents: number;
}

export interface EmitRequest {
  /** Id del `Document` en el API: la clave de idempotencia. */
  externalId: string;
  docType: BillingDocType;
  series: string;
  number: number;
  /** Fecha de emisión (America/Lima), `YYYY-MM-DD`. */
  issueDate: string;
  currency: 'USD' | 'PEN';
  /** Obligatorio si la moneda es USD. */
  exchangeRate?: string;
  igvRate: string;
  customer: BillingCustomer;
  items: BillingItem[];
  totalCents: number;
  submission?: 'IMMEDIATE' | 'DAILY_SUMMARY';
  affectedDocument?: {
    docType: 'BOLETA' | 'FACTURA';
    series: string;
    number: number;
  };
  reasonCode?: string;
  reason?: string;
  notes?: string;
}

export interface EmitResult {
  externalId: string;
  status: BillingDocStatus;
  taxableCents?: number;
  igvCents?: number;
  totalCents?: number;
  hash?: string;
  sunatCode?: string | null;
  sunatMessage?: string | null;
  ticket?: string | null;
  files?: { xml?: boolean; cdr?: boolean; pdf?: boolean };
}

export interface TicketResult {
  ticket: string;
  status: 'PENDING' | 'ACCEPTED' | 'REJECTED' | 'ERROR';
  sunatCode?: string | null;
  sunatMessage?: string | null;
}

export interface BillingFile {
  data: Buffer;
  contentType: string;
}

/** Error de `desertica-billing` (códigos de `Error.code` de `billing.yaml`). */
export class BillingError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly httpStatus: number,
    /** Se puede reintentar con la misma `externalId` (SUNAT u OSE caído, red). */
    readonly retryable: boolean,
    readonly sunatCode?: string,
  ) {
    super(message);
  }
}

export interface BillingClient {
  emit(request: EmitRequest): Promise<EmitResult>;
  /** `null` si billing no conoce la `externalId`. */
  getStatus(externalId: string): Promise<EmitResult | null>;
  /** `null` si el archivo todavía no existe. */
  downloadFile(
    externalId: string,
    kind: BillingFileKind,
  ): Promise<BillingFile | null>;
  void(
    externalId: string,
    request: { reason: string; voidDate: string },
  ): Promise<TicketResult>;
  getTicket(ticket: string): Promise<TicketResult | null>;
}

export const BILLING_CLIENT = Symbol('BILLING_CLIENT');
