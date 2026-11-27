import type { Currency } from '../../../generated/prisma/client';
import {
  CreatePaymentInput,
  GatewayError,
  GatewayEvent,
  GatewayNotConfiguredError,
  GatewayPayment,
  GatewayRefund,
  InvalidWebhookSignatureError,
  PaymentGateway,
  RefundInput,
} from './payment-gateway';

export interface CulqiGatewayOptions {
  secretKey: string;
  publicKey: string;
  /** `https://api.culqi.com/v2`; en pruebas, un servidor local. */
  apiUrl: string;
}

type Json = Record<string, unknown>;

/** Texto de un campo de la respuesta (cadena o número); vacío si no es ninguno. */
const text = (value: unknown): string =>
  typeof value === 'string'
    ? value
    : typeof value === 'number'
      ? String(value)
      : '';

/**
 * Adaptador de Culqi (USD y PEN), contrastado con docs.culqi.com y
 * apidocs.culqi.com (noviembre de 2026):
 * - `POST /v2/charges`: `amount` entero en céntimos (100..9 999 900),
 *   `currency_code` `PEN` o `USD`. Responde 201 si cobró y 200 con
 *   `{ action_code: "REVIEW" }` si el banco pide 3DS; el reintento repite el
 *   mismo `source_id` y `device_finger_print_id` y añade `authentication_3DS`.
 * - `POST /v2/refunds`: `reason` es `duplicado`, `fraudulento` o
 *   `solicitud_comprador`; `status` vuelve como `Completa`, `Pendiente` o
 *   `Rechazado` (mayúsculas variables).
 * - Webhooks: Culqi **no documenta firma** del webhook. Por eso el cuerpo no
 *   se cree: solo se toma el id del evento y se consulta `GET /v2/events/{id}`
 *   con la clave secreta; un id que Culqi no conoce es un evento falso (400).
 *   Los cargos se vuelven a consultar con `GET /v2/charges/{id}`.
 */
export class CulqiGateway implements PaymentGateway {
  readonly provider = 'CULQI' as const;
  readonly currencies: readonly Currency[] = ['USD', 'PEN'];

  constructor(
    private readonly options: CulqiGatewayOptions,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  publicKey(): string {
    return this.options.publicKey;
  }

  async createPayment(input: CreatePaymentInput): Promise<GatewayPayment> {
    if (!input.token || !input.email) {
      throw new GatewayError('A Culqi token and email are required', 'invalid');
    }
    const body: Json = {
      amount: input.amountCents,
      currency_code: input.currency,
      email: input.email,
      source_id: input.token,
      capture: true,
      description: input.description.slice(0, 80),
      metadata: {
        paymentId: input.paymentId,
        bookingReference: input.bookingReference,
      },
    };
    if (input.deviceId)
      body.antifraud_details = { device_finger_print_id: input.deviceId };
    if (input.authentication3DS)
      body.authentication_3DS = input.authentication3DS;
    const charge = await this.call('POST', '/charges', body);
    return this.fromCharge(charge, {
      amountCents: input.amountCents,
      currency: input.currency,
    });
  }

  async retrievePayment(providerRef: string): Promise<GatewayPayment> {
    return this.fromCharge(
      await this.call('GET', `/charges/${encodeURIComponent(providerRef)}`),
    );
  }

  async refund(input: RefundInput): Promise<GatewayRefund> {
    const refund = await this.call('POST', '/refunds', {
      amount: input.amountCents,
      charge_id: input.paymentProviderRef,
      reason: 'solicitud_comprador',
      metadata: { refundId: input.refundId },
    });
    return this.fromRefund(refund, input);
  }

  private fromRefund(
    refund: Json,
    fallback?: { paymentProviderRef: string; amountCents: number },
  ): GatewayRefund {
    const status = text(refund.status).toLowerCase();
    return {
      providerRef: text(refund.id),
      paymentProviderRef:
        text(refund.charge_id) || (fallback?.paymentProviderRef ?? ''),
      // Sin estado (respuesta 201 sin `status`) se toma como hecha.
      status: status.startsWith('pendiente')
        ? 'PENDING'
        : status.startsWith('rechazad')
          ? 'FAILED'
          : 'SUCCEEDED',
      amountCents: Number(refund.amount ?? fallback?.amountCents ?? 0),
    };
  }

  async parseWebhook(rawBody: Buffer): Promise<GatewayEvent> {
    let posted: Json;
    try {
      posted = JSON.parse(rawBody.toString('utf8')) as Json;
    } catch {
      throw new InvalidWebhookSignatureError('Body is not JSON');
    }
    const eventId = typeof posted.id === 'string' ? posted.id : '';
    // Culqi usa ids de 25 caracteres (`evt_test_0CjjdWhFpEAZlxlz`); otro largo ni se consulta.
    if (!/^evt_(test|live)_[A-Za-z0-9]{16}$/.test(eventId)) {
      throw new InvalidWebhookSignatureError('Missing Culqi event id');
    }

    // Culqi no firma sus webhooks: el evento auténtico es el que Culqi devuelve.
    let event: Json;
    try {
      event = await this.call('GET', `/events/${eventId}`);
    } catch (error) {
      // Evento inexistente: Culqi responde 400 `parameter_error` (o 404 `resource_error`).
      // Un 401 (`authentication_error`) es nuestra clave mal puesta y sigue como error.
      if (
        error instanceof GatewayError &&
        (error.code === 'parameter_error' || error.code === 'resource_error')
      ) {
        throw new InvalidWebhookSignatureError('Unknown Culqi event');
      }
      throw error;
    }
    const type = typeof event.type === 'string' ? event.type : 'unknown';
    let data: unknown = event.data;
    if (typeof data === 'string') {
      try {
        data = JSON.parse(data);
      } catch {
        data = null;
      }
    }
    const d = (data && typeof data === 'object' ? data : {}) as Json;

    if (d.object === 'refund' && typeof d.id === 'string') {
      return { kind: 'refund', eventId, type, refund: this.fromRefund(d) };
    }
    if (d.object === 'charge' && typeof d.id === 'string') {
      // El cargo se relee para tener su estado actual, no el del evento.
      const payment = await this.retrievePayment(d.id);
      if (payment.status === 'PENDING' && /fail/i.test(type)) {
        payment.status = 'FAILED';
      }
      return { kind: 'payment', eventId, type, payment };
    }
    return { kind: 'ignored', eventId, type };
  }

  private fromCharge(
    charge: Json,
    fallback?: { amountCents: number; currency: Currency },
  ): GatewayPayment {
    const review = charge.action_code === 'REVIEW';
    const code = (
      text(charge.currency) ||
      text(charge.currency_code) ||
      (review ? (fallback?.currency ?? '') : '')
    ).toUpperCase();
    if (code !== 'USD' && code !== 'PEN') {
      throw new GatewayError(
        `Unsupported currency ${code}`,
        'currency_unsupported',
      );
    }
    const outcome = (charge.outcome ?? {}) as Json;
    const metadata: Record<string, string> = {};
    for (const [k, v] of Object.entries((charge.metadata ?? {}) as Json)) {
      metadata[k] = String(v);
    }
    const currency: Currency = code === 'USD' ? 'USD' : 'PEN';
    const base = {
      providerRef: typeof charge.id === 'string' ? charge.id : '',
      amountCents: Number(
        charge.amount ?? (review ? fallback?.amountCents : undefined),
      ),
      currency,
      metadata,
      disputed: charge.dispute === true,
      ...(typeof charge.amount_refunded === 'number'
        ? { refundedCents: charge.amount_refunded }
        : {}),
    };
    if (review) {
      return {
        ...base,
        status: 'REQUIRES_ACTION',
        action: { type: 'THREE_DS', parameters: {} },
      };
    }
    if (
      charge.paid === true ||
      outcome.type === 'venta_exitosa' ||
      charge.response_code === 'venta_exitosa'
    ) {
      return { ...base, status: 'SUCCEEDED', method: 'CARD' };
    }
    return {
      ...base,
      status: 'PENDING',
      failureCode: typeof outcome.code === 'string' ? outcome.code : undefined,
      failureMessage:
        typeof outcome.user_message === 'string'
          ? outcome.user_message
          : undefined,
    };
  }

  private async call(
    method: 'GET' | 'POST',
    path: string,
    body?: Json,
  ): Promise<Json> {
    if (!this.options.secretKey) {
      throw new GatewayNotConfiguredError('Culqi is not configured');
    }
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.options.apiUrl}${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.options.secretKey}`,
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(20_000),
      });
    } catch (error) {
      throw new GatewayError(
        error instanceof Error ? error.message : 'Culqi is unreachable',
        'unreachable',
      );
    }
    let json: Json;
    try {
      json = (await response.json()) as Json;
    } catch {
      throw new GatewayError(
        `Culqi answered ${response.status} without JSON`,
        'bad_response',
      );
    }
    if (!response.ok) {
      const declined = json.type === 'card_error';
      throw new GatewayError(
        text(json.user_message) || text(json.merchant_message) || 'Culqi error',
        // `type` (p. ej. `resource_error` en un 404) solo si no hay código.
        text(json.decline_code) ||
          text(json.code) ||
          text(json.type) ||
          undefined,
        declined,
      );
    }
    return json;
  }
}
