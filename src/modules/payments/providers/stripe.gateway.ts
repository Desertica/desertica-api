import Stripe from 'stripe';
import type { Currency } from '../../../generated/prisma/client';
import {
  CreatePaymentInput,
  GatewayDispute,
  GatewayError,
  GatewayEvent,
  GatewayNotConfiguredError,
  GatewayPayment,
  GatewayPaymentStatus,
  GatewayRefund,
  InvalidWebhookSignatureError,
  PaymentGateway,
  RefundInput,
} from './payment-gateway';

export interface StripeGatewayOptions {
  secretKey: string;
  publishableKey: string;
  webhookSecret: string;
  /** Solo pruebas: apunta el SDK a un servidor local en vez de api.stripe.com. */
  apiHost?: { host: string; port: number; protocol: 'http' | 'https' };
  /** Consulta el cargo para distinguir Apple Pay y Google Pay (una llamada extra por pago). */
  enrichMethod?: boolean;
}

const PI_STATUS: Record<string, GatewayPaymentStatus> = {
  succeeded: 'SUCCEEDED',
  canceled: 'CANCELLED',
  requires_action: 'REQUIRES_ACTION',
};

const WALLETS = new Set(['apple_pay', 'google_pay']);

/** Stripe solo cobra USD (regla del proyecto). */
export class StripeGateway implements PaymentGateway {
  readonly provider = 'STRIPE' as const;
  readonly currencies: readonly Currency[] = ['USD'];
  private client?: Stripe;

  constructor(private readonly options: StripeGatewayOptions) {}

  private stripe(): Stripe {
    if (!this.options.secretKey) {
      throw new GatewayNotConfiguredError('Stripe is not configured');
    }
    this.client ??= new Stripe(this.options.secretKey, {
      maxNetworkRetries: 2,
      timeout: 15_000,
      ...(this.options.apiHost ?? {}),
    });
    return this.client;
  }

  publicKey(): string {
    if (!this.options.publishableKey) {
      throw new GatewayNotConfiguredError('Stripe is not configured');
    }
    return this.options.publishableKey;
  }

  async createPayment(input: CreatePaymentInput): Promise<GatewayPayment> {
    if (input.currency !== 'USD') {
      throw new GatewayError('Stripe only charges USD', 'currency_unsupported');
    }
    try {
      const intent = await this.stripe().paymentIntents.create(
        {
          amount: input.amountCents,
          currency: 'usd',
          // Métodos automáticos: Apple Pay y Google Pay salen con el Express Checkout Element.
          automatic_payment_methods: { enabled: true },
          description: input.description,
          metadata: {
            paymentId: input.paymentId,
            bookingReference: input.bookingReference,
          },
        },
        { idempotencyKey: `payment:${input.paymentId}` },
      );
      return this.fromIntent(intent);
    } catch (error) {
      throw this.wrap(error);
    }
  }

  async retrievePayment(providerRef: string): Promise<GatewayPayment> {
    try {
      return this.fromIntent(
        await this.stripe().paymentIntents.retrieve(providerRef),
      );
    } catch (error) {
      throw this.wrap(error);
    }
  }

  async refund(input: RefundInput): Promise<GatewayRefund> {
    try {
      const refund = await this.stripe().refunds.create(
        {
          payment_intent: input.paymentProviderRef,
          amount: input.amountCents,
          reason: 'requested_by_customer',
          metadata: { refundId: input.refundId },
        },
        { idempotencyKey: `refund:${input.refundId}` },
      );
      return this.fromRefund(refund);
    } catch (error) {
      throw this.wrap(error);
    }
  }

  async parseWebhook(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
  ): Promise<GatewayEvent> {
    const signature = headers['stripe-signature'];
    if (!this.options.webhookSecret) {
      throw new GatewayNotConfiguredError('Stripe webhook is not configured');
    }
    if (typeof signature !== 'string' || !signature) {
      throw new InvalidWebhookSignatureError('Missing Stripe-Signature');
    }
    let event: Stripe.Event;
    try {
      event = this.stripe().webhooks.constructEvent(
        rawBody,
        signature,
        this.options.webhookSecret,
      );
    } catch (error) {
      throw new InvalidWebhookSignatureError(
        error instanceof Error ? error.message : 'Invalid signature',
      );
    }
    return this.normalize(event);
  }

  private async normalize(event: Stripe.Event): Promise<GatewayEvent> {
    const base = { eventId: event.id, type: event.type };
    switch (event.type) {
      case 'payment_intent.succeeded':
      case 'payment_intent.payment_failed':
      case 'payment_intent.canceled':
      case 'payment_intent.requires_action': {
        const intent = event.data.object;
        const payment = this.fromIntent(intent);
        if (!payment) return { kind: 'ignored', ...base };
        if (event.type === 'payment_intent.payment_failed') {
          payment.status = 'FAILED';
        }
        if (event.type === 'payment_intent.succeeded') {
          payment.method = await this.methodOf(intent);
        }
        return { kind: 'payment', ...base, payment };
      }
      case 'refund.created':
      case 'refund.updated':
      case 'refund.failed': {
        const refund = this.fromRefund(event.data.object);
        return refund
          ? { kind: 'refund', ...base, refund }
          : { kind: 'ignored', ...base };
      }
      case 'charge.dispute.created':
      case 'charge.dispute.updated':
      case 'charge.dispute.closed':
      case 'charge.dispute.funds_withdrawn':
      case 'charge.dispute.funds_reinstated': {
        const dispute = this.fromDispute(event.data.object);
        return dispute
          ? { kind: 'dispute', ...base, dispute }
          : { kind: 'ignored', ...base };
      }
      default:
        return { kind: 'ignored', ...base };
    }
  }

  private async methodOf(
    intent: Stripe.PaymentIntent,
  ): Promise<'CARD' | 'WALLET'> {
    if (this.options.enrichMethod === false) return 'CARD';
    try {
      const full = await this.stripe().paymentIntents.retrieve(intent.id, {
        expand: ['latest_charge'],
      });
      const charge = full.latest_charge;
      const wallet =
        charge && typeof charge !== 'string'
          ? charge.payment_method_details?.card?.wallet?.type
          : undefined;
      return wallet && WALLETS.has(wallet) ? 'WALLET' : 'CARD';
    } catch {
      return 'CARD';
    }
  }

  private currencyOf(code: string): Currency | null {
    const upper = code.toUpperCase();
    return upper === 'USD' || upper === 'PEN' ? upper : null;
  }

  private fromIntent(intent: Stripe.PaymentIntent): GatewayPayment {
    const currency = this.currencyOf(intent.currency);
    if (!currency) {
      throw new GatewayError(
        `Unsupported currency ${intent.currency}`,
        'currency_unsupported',
      );
    }
    const error = intent.last_payment_error;
    return {
      providerRef: intent.id,
      status: PI_STATUS[intent.status] ?? 'PENDING',
      amountCents: intent.amount,
      currency,
      clientSecret: intent.client_secret ?? undefined,
      failureCode: error?.decline_code ?? error?.code ?? undefined,
      failureMessage: error?.message ?? undefined,
      metadata: { ...(intent.metadata ?? {}) },
    };
  }

  private fromRefund(refund: Stripe.Refund): GatewayRefund {
    const intent =
      typeof refund.payment_intent === 'string'
        ? refund.payment_intent
        : refund.payment_intent?.id;
    const status =
      refund.status === 'succeeded'
        ? 'SUCCEEDED'
        : refund.status === 'failed' || refund.status === 'canceled'
          ? 'FAILED'
          : 'PENDING';
    return {
      providerRef: refund.id,
      paymentProviderRef: intent ?? '',
      status,
      amountCents: refund.amount,
      failureCode: refund.failure_reason ?? undefined,
    };
  }

  private fromDispute(dispute: Stripe.Dispute): GatewayDispute | null {
    const intent =
      typeof dispute.payment_intent === 'string'
        ? dispute.payment_intent
        : dispute.payment_intent?.id;
    const currency = this.currencyOf(dispute.currency);
    if (!intent || !currency) return null;
    const status =
      dispute.status === 'won'
        ? 'WON'
        : dispute.status === 'lost'
          ? 'LOST'
          : dispute.status === 'warning_closed' ||
              dispute.status === 'prevented'
            ? 'CLOSED'
            : 'OPEN';
    const due = dispute.evidence_details?.due_by;
    return {
      providerRef: dispute.id,
      paymentProviderRef: intent,
      status,
      reason: dispute.reason ?? null,
      amountCents: dispute.amount,
      currency,
      evidenceDueAt: due ? new Date(due * 1000) : null,
    };
  }

  private wrap(error: unknown): Error {
    if (error instanceof GatewayNotConfiguredError) return error;
    if (error instanceof Stripe.errors.StripeCardError) {
      return new GatewayError(
        error.message,
        error.decline_code ?? error.code,
        true,
      );
    }
    if (error instanceof Stripe.errors.StripeError) {
      return new GatewayError(error.message, error.code);
    }
    return error instanceof Error ? error : new Error(String(error));
  }
}
