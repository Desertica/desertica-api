import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
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
  webhookSecret: string;
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
 * Adaptador de Culqi (USD y PEN).
 *
 * IMPORTANTE: el entorno donde se escribió no tenía acceso a docs.culqi.com ni
 * a api.culqi.com. Lo que sigue se basó en los tipos de `culqi-node@2.1.0`
 * (endpoints `/v2/charges` y `/v2/refunds`, campos `amount`, `currency_code`,
 * `email`, `source_id`, `charge_id`, `outcome`, `paid`, `dispute`). Tres cosas
 * NO están verificadas contra la documentación oficial y deben revisarse con
 * una clave de prueba: (1) la señal de 3DS pendiente (`action_code: "REVIEW"`)
 * y el campo `authentication_3DS` del reintento; (2) el esquema de firma del
 * webhook (aquí HMAC-SHA256 del cuerpo en `x-culqi-signature`); (3) los
 * valores permitidos de `reason` en reembolsos.
 *
 * Como la firma no está verificada, el webhook nunca confía en su contenido:
 * solo usa el id del cargo y vuelve a consultarlo a Culqi con la clave secreta.
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
      amount: String(input.amountCents),
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
    return {
      providerRef: text(refund.id),
      paymentProviderRef: text(refund.charge_id) || input.paymentProviderRef,
      status: 'SUCCEEDED',
      amountCents: Number(refund.amount ?? input.amountCents),
    };
  }

  async parseWebhook(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
  ): Promise<GatewayEvent> {
    if (!this.options.webhookSecret) {
      throw new GatewayNotConfiguredError('Culqi webhook is not configured');
    }
    this.verifySignature(rawBody, headers['x-culqi-signature']);

    let event: Json;
    try {
      event = JSON.parse(rawBody.toString('utf8')) as Json;
    } catch {
      throw new InvalidWebhookSignatureError('Body is not JSON');
    }
    const type = typeof event.type === 'string' ? event.type : 'unknown';
    const eventId =
      typeof event.id === 'string' && event.id
        ? event.id
        : `sha256:${createHash('sha256').update(rawBody).digest('hex')}`;
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
      return {
        kind: 'refund',
        eventId,
        type,
        refund: {
          providerRef: d.id,
          paymentProviderRef: text(d.charge_id),
          status: 'SUCCEEDED',
          amountCents: Number(d.amount ?? 0),
        },
      };
    }
    if (d.object === 'charge' && typeof d.id === 'string') {
      // No se confía en el cuerpo: se consulta el cargo real.
      const payment = await this.retrievePayment(d.id);
      if (payment.status === 'PENDING' && /fail/i.test(type)) {
        payment.status = 'FAILED';
      }
      return { kind: 'payment', eventId, type, payment };
    }
    return { kind: 'ignored', eventId, type };
  }

  private verifySignature(
    rawBody: Buffer,
    header: string | string[] | undefined,
  ): void {
    const received = (Array.isArray(header) ? header[0] : header)
      ?.replace(/^sha256=/, '')
      .toLowerCase();
    if (!received) throw new InvalidWebhookSignatureError('Missing signature');
    const expected = createHmac('sha256', this.options.webhookSecret)
      .update(rawBody)
      .digest('hex');
    const a = Buffer.from(received);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new InvalidWebhookSignatureError('Invalid signature');
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
    if (charge.paid === true || outcome.type === 'venta_exitosa') {
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
        typeof json.decline_code === 'string'
          ? json.decline_code
          : typeof json.code === 'string'
            ? json.code
            : undefined,
        declined,
      );
    }
    return json;
  }
}
