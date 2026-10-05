import type {
  Currency,
  DisputeStatus,
  PaymentMethod,
  PaymentProvider,
} from '../../../generated/prisma/client';

/** Estado de un cobro, ya normalizado (el adaptador traduce el de la pasarela). */
export type GatewayPaymentStatus =
  'PENDING' | 'REQUIRES_ACTION' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';

export interface GatewayPayment {
  /** Id del intent (Stripe) o del cargo (Culqi). */
  providerRef: string;
  status: GatewayPaymentStatus;
  amountCents: number;
  currency: Currency;
  method?: Extract<PaymentMethod, 'CARD' | 'WALLET'>;
  /** Solo Stripe: lo usa el navegador para confirmar el pago. */
  clientSecret?: string;
  /** Solo Culqi: autenticación 3DS pendiente en el navegador. */
  action?: { type: 'THREE_DS'; parameters: Record<string, unknown> };
  failureCode?: string;
  failureMessage?: string;
  /** `paymentId` y `bookingReference` que mandamos al crear el cobro. */
  metadata: Record<string, string>;
  /** El cargo tiene una disputa abierta (Culqi la indica en el propio cargo). */
  disputed?: boolean;
  /** Total ya devuelto según la pasarela (Culqi: `amount_refunded`). */
  refundedCents?: number;
}

export interface GatewayRefund {
  providerRef: string;
  /** Id del cobro (`providerRef` del `Payment`) al que pertenece. */
  paymentProviderRef: string;
  status: 'PENDING' | 'SUCCEEDED' | 'FAILED';
  amountCents: number;
  failureCode?: string;
}

export interface GatewayDispute {
  providerRef: string;
  paymentProviderRef: string;
  status: DisputeStatus;
  reason: string | null;
  amountCents: number;
  currency: Currency;
  evidenceDueAt: Date | null;
}

/** Evento de webhook con la firma ya validada y el contenido normalizado. */
export type GatewayEvent =
  | { kind: 'payment'; eventId: string; type: string; payment: GatewayPayment }
  | { kind: 'refund'; eventId: string; type: string; refund: GatewayRefund }
  | {
      kind: 'dispute';
      eventId: string;
      type: string;
      dispute: GatewayDispute;
    }
  | { kind: 'ignored'; eventId: string; type: string };

export interface CreatePaymentInput {
  /** `Payment.id`: también es la clave de idempotencia hacia la pasarela. */
  paymentId: string;
  bookingReference: string;
  amountCents: number;
  currency: Currency;
  description: string;
  /** Token de Culqi.js (nunca un número de tarjeta). */
  token?: string;
  email?: string;
  /** Parámetros que devolvió la autenticación 3DS en el navegador (Culqi). */
  authentication3DS?: Record<string, unknown>;
}

export interface RefundInput {
  /** `Refund.id`: clave de idempotencia hacia la pasarela. */
  refundId: string;
  paymentProviderRef: string;
  amountCents: number;
  currency: Currency;
  reason: string;
}

/** La firma del webhook no es válida (o falta): el API responde 400. */
export class InvalidWebhookSignatureError extends Error {}

/** La pasarela no está configurada (faltan claves): el API responde 503. */
export class GatewayNotConfiguredError extends Error {}

/** La pasarela rechazó o falló la llamada. `declined` = el banco dijo que no. */
export class GatewayError extends Error {
  constructor(
    message: string,
    readonly code: string | undefined,
    readonly declined = false,
  ) {
    super(message);
  }
}

/**
 * Todo lo que mueve dinero pasa por esta interfaz. Hay un adaptador por
 * pasarela (`StripeGateway`, `CulqiGateway`) y uno falso para pruebas.
 */
export interface PaymentGateway {
  readonly provider: Extract<PaymentProvider, 'STRIPE' | 'CULQI'>;
  readonly currencies: readonly Currency[];
  /** Clave que el navegador necesita (Stripe: publishable key). */
  publicKey(): string;
  createPayment(input: CreatePaymentInput): Promise<GatewayPayment>;
  retrievePayment(providerRef: string): Promise<GatewayPayment>;
  refund(input: RefundInput): Promise<GatewayRefund>;
  /** Valida la firma sobre el cuerpo crudo y devuelve el evento normalizado. */
  parseWebhook(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
  ): Promise<GatewayEvent>;
}

export const PAYMENT_GATEWAYS = Symbol('PAYMENT_GATEWAYS');
