import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Currency } from '../../../generated/prisma/client';
import {
  CreatePaymentInput,
  GatewayError,
  GatewayEvent,
  GatewayPayment,
  GatewayRefund,
  InvalidWebhookSignatureError,
  PaymentGateway,
  RefundInput,
} from './payment-gateway';

export const FAKE_WEBHOOK_SECRET = 'fake-webhook-secret';

/**
 * Pasarela simulada (`PAYMENT_GATEWAY_MODE=fake` y pruebas). No mueve dinero.
 *
 * Tokens de Culqi simulados: `tok_ok` cobra, `tok_declined` rechaza,
 * `tok_3ds` pide 3DS (y cobra al reintentar con `authentication3DS`),
 * `tok_pending` deja el cargo sin resolver. Los webhooks son el
 * `GatewayEvent` en JSON firmado con HMAC en `x-fake-signature`
 * (ver `signFakeEvent`).
 */
export class FakeGateway implements PaymentGateway {
  readonly currencies: readonly Currency[];
  readonly payments = new Map<string, GatewayPayment>();
  readonly refunds: GatewayRefund[] = [];
  /** Cuántas veces se llamó a `createPayment` (comprueba la idempotencia). */
  createCalls = 0;
  failRefunds = false;
  /** Código del error cuando `failRefunds` está activo (`unreachable` se reintenta). */
  refundFailureCode = 'refund_failed';
  /** El reembolso se aplica pero la respuesta se pierde (`unreachable`): el caso ambiguo. */
  loseRefundResponse = false;

  constructor(readonly provider: 'STRIPE' | 'CULQI') {
    this.currencies = provider === 'STRIPE' ? ['USD'] : ['USD', 'PEN'];
  }

  publicKey(): string {
    return `pk_fake_${this.provider.toLowerCase()}`;
  }

  createPayment(input: CreatePaymentInput): Promise<GatewayPayment> {
    this.createCalls++;
    if (!this.currencies.includes(input.currency)) {
      return Promise.reject(
        new GatewayError('Currency not supported', 'currency_unsupported'),
      );
    }
    const metadata = {
      paymentId: input.paymentId,
      bookingReference: input.bookingReference,
    };
    const base = {
      amountCents: input.amountCents,
      currency: input.currency,
      metadata,
    };
    if (this.provider === 'STRIPE') {
      const providerRef = `pi_fake_${randomUUID()}`;
      const payment: GatewayPayment = {
        ...base,
        providerRef,
        status: 'PENDING',
        clientSecret: `${providerRef}_secret_fake`,
      };
      this.payments.set(providerRef, payment);
      return Promise.resolve(payment);
    }
    const providerRef = `chr_fake_${randomUUID()}`;
    let payment: GatewayPayment;
    switch (input.token) {
      case 'tok_declined':
        return Promise.reject(
          new GatewayError('Card declined', 'insufficient_funds', true),
        );
      case 'tok_3ds':
        payment = input.authentication3DS
          ? { ...base, providerRef, status: 'SUCCEEDED', method: 'CARD' }
          : {
              ...base,
              providerRef,
              status: 'REQUIRES_ACTION',
              action: { type: 'THREE_DS', parameters: {} },
            };
        break;
      case 'tok_pending':
        payment = { ...base, providerRef, status: 'PENDING' };
        break;
      case 'tok_ok':
        payment = { ...base, providerRef, status: 'SUCCEEDED', method: 'CARD' };
        break;
      default:
        return Promise.reject(
          new GatewayError('Unknown token', 'invalid_token', true),
        );
    }
    this.payments.set(providerRef, payment);
    return Promise.resolve(payment);
  }

  retrievePayment(providerRef: string): Promise<GatewayPayment> {
    const payment = this.payments.get(providerRef);
    return payment
      ? Promise.resolve(payment)
      : Promise.reject(new GatewayError('Not found', 'not_found'));
  }

  refund(input: RefundInput): Promise<GatewayRefund> {
    if (this.loseRefundResponse) {
      const charge = this.payments.get(input.paymentProviderRef);
      if (charge) {
        charge.refundedCents = (charge.refundedCents ?? 0) + input.amountCents;
      }
      return Promise.reject(new GatewayError('Timed out', 'unreachable'));
    }
    if (this.failRefunds) {
      return Promise.reject(
        new GatewayError('Refund refused', this.refundFailureCode),
      );
    }
    const refund: GatewayRefund = {
      providerRef: `re_fake_${input.refundId}`,
      paymentProviderRef: input.paymentProviderRef,
      status: 'SUCCEEDED',
      amountCents: input.amountCents,
    };
    this.refunds.push(refund);
    return Promise.resolve(refund);
  }

  parseWebhook(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
  ): Promise<GatewayEvent> {
    const header = headers['x-fake-signature'];
    const received = typeof header === 'string' ? header : '';
    const expected = signFake(rawBody);
    const a = Buffer.from(received);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return Promise.reject(
        new InvalidWebhookSignatureError('Invalid signature'),
      );
    }
    const event = JSON.parse(rawBody.toString('utf8')) as GatewayEvent;
    if (event.kind === 'dispute' && event.dispute.evidenceDueAt) {
      event.dispute.evidenceDueAt = new Date(event.dispute.evidenceDueAt);
    }
    return Promise.resolve(event);
  }
}

const signFake = (body: Buffer | string) =>
  createHmac('sha256', FAKE_WEBHOOK_SECRET).update(body).digest('hex');

/** Cuerpo y cabecera de un webhook simulado válido. */
export function signFakeEvent(event: GatewayEvent): {
  body: string;
  headers: Record<string, string>;
} {
  const body = JSON.stringify(event);
  return {
    body,
    headers: {
      'content-type': 'application/json',
      'x-fake-signature': signFake(body),
    },
  };
}
