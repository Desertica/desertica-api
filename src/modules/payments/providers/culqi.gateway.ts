import { Logger } from '@nestjs/common';
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
 * - Un rechazo del banco responde 402 con `type` `card_error` u
 *   `operacion_denegada` y el mensaje para el cliente en `user_message`; el
 *   cargo releído trae `outcome.type: "operacion_denegada"` y `paid: false`.
 * - Webhooks: Culqi **no firma** el webhook, y el id del evento que envía no es
 *   uno que `GET /v2/events/{id}` acepte. Por eso del cuerpo solo se toma el id
 *   del objeto al que apunta (`data.id` si `data.object` es `charge` o `refund`,
 *   `data.chargeId` si es `error`, p. ej. `charge.creation.failed`) y ese objeto
 *   se relee con la clave secreta (`GET /v2/charges/{id}` o `/v2/refunds/{id}`):
 *   lo que Culqi responde es la verdad, y un id que Culqi no conoce es un evento
 *   falso (400). El id y el tipo del evento enviado solo sirven para deduplicar.
 */
export class CulqiGateway implements PaymentGateway {
  private readonly logger = new Logger(CulqiGateway.name);
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
      if (!posted || typeof posted !== 'object') throw new Error();
    } catch {
      throw new InvalidWebhookSignatureError('Body is not JSON');
    }
    // Solo clave de deduplicación: Culqi usa ids de 25 caracteres (`evt_test_0CjjdWhFpEAZlxlz`).
    const eventId = typeof posted.id === 'string' ? posted.id : '';
    if (!/^evt_(test|live)_[A-Za-z0-9]{16}$/.test(eventId)) {
      throw new InvalidWebhookSignatureError('Missing Culqi event id');
    }
    const type =
      typeof posted.type === 'string' && /^[a-z0-9._]{1,64}$/i.test(posted.type)
        ? posted.type
        : 'unknown';
    let data: unknown = posted.data;
    if (typeof data === 'string') {
      try {
        data = JSON.parse(data);
      } catch {
        data = null;
      }
    }
    const d = (data && typeof data === 'object' ? data : {}) as Json;

    // Del cuerpo (sin firma) solo sale el id del objeto; su estado se relee de Culqi.
    const chargeId =
      d.object === 'charge' ? d.id : d.object === 'error' ? d.chargeId : null;
    if (typeof chargeId === 'string') {
      const payment = await this.reread(
        chargeId,
        /^chr_(test|live)_[A-Za-z0-9]{8,40}$/,
        () => this.retrievePayment(chargeId),
      );
      return { kind: 'payment', eventId, type, payment };
    }
    if (d.object === 'refund' && typeof d.id === 'string') {
      const id = d.id;
      const refund = await this.reread(
        id,
        /^ref_(test|live)_[A-Za-z0-9]{8,40}$/,
        async () => this.fromRefund(await this.call('GET', `/refunds/${id}`)),
      );
      return { kind: 'refund', eventId, type, refund };
    }
    // Solo la forma, nunca valores: el cuerpo puede traer datos de la tarjeta.
    this.logger.warn(
      `Ignored Culqi webhook: keys=${Object.keys(posted).join(',')} data.object=${typeof d.object === 'string' ? d.object.slice(0, 20) : typeof d.object}`,
    );
    return { kind: 'ignored', eventId, type };
  }

  /** Relee un objeto de Culqi; un id mal formado o que Culqi no conoce es un webhook falso. */
  private async reread<T>(
    id: string,
    format: RegExp,
    read: () => Promise<T>,
  ): Promise<T> {
    if (!format.test(id)) {
      throw new InvalidWebhookSignatureError('Bad Culqi object id');
    }
    try {
      return await read();
    } catch (error) {
      // Objeto inexistente: Culqi responde 400 `parameter_error` (o 404). Un 401 es
      // nuestra clave mal puesta y sigue como error.
      if (
        error instanceof GatewayError &&
        (error.httpStatus === 400 || error.httpStatus === 404)
      ) {
        throw new InvalidWebhookSignatureError('Unknown Culqi object');
      }
      throw error;
    }
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
      // `operacion_denegada` (o `venta_denegada`): el banco lo rechazó y es definitivo.
      status: /denegad/.test(text(outcome.type)) ? 'FAILED' : 'PENDING',
      failureCode:
        text(outcome.decline_code) || text(outcome.code) || undefined,
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
      // Rechazo del banco: 402; el doc dice `card_error`, los eventos reales `operacion_denegada`.
      const declined =
        response.status === 402 ||
        json.type === 'card_error' ||
        json.type === 'operacion_denegada';
      throw new GatewayError(
        text(json.user_message) ||
          text(json.userMessage) ||
          text(json.merchant_message) ||
          text(json.merchantMessage) ||
          'Culqi error',
        // `type` (p. ej. `resource_error` en un 404) solo si no hay código.
        text(json.decline_code) ||
          text(json.declineCode) ||
          text(json.code) ||
          text(json.type) ||
          undefined,
        declined,
        response.status,
      );
    }
    return json;
  }
}
