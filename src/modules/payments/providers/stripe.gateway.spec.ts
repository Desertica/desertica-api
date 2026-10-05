import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import Stripe from 'stripe';
import { StripeGateway } from './stripe.gateway';
import {
  GatewayNotConfiguredError,
  InvalidWebhookSignatureError,
} from './payment-gateway';

const SECRET = 'whsec_test_secret';
const stripe = new Stripe('sk_test_unused');

const gateway = (over = {}) =>
  new StripeGateway({
    secretKey: 'sk_test_x',
    publishableKey: 'pk_test_x',
    webhookSecret: SECRET,
    enrichMethod: false,
    ...over,
  });

function signed(event: object, secret = SECRET) {
  const payload = JSON.stringify(event);
  return {
    body: Buffer.from(payload),
    headers: {
      'stripe-signature': stripe.webhooks.generateTestHeaderString({
        payload,
        secret,
      }),
    },
  };
}

const intent = (over: object = {}) => ({
  id: 'pi_123',
  object: 'payment_intent',
  amount: 10000,
  currency: 'usd',
  status: 'succeeded',
  client_secret: 'pi_123_secret_abc',
  metadata: { paymentId: 'p-1', bookingReference: 'DST-1' },
  last_payment_error: null,
  ...over,
});

const event = (type: string, object: object, id = 'evt_1') => ({
  id,
  object: 'event',
  type,
  data: { object },
});

describe('StripeGateway webhooks', () => {
  it('accepts a signed payment_intent.succeeded and normalizes it', async () => {
    const { body, headers } = signed(
      event('payment_intent.succeeded', intent()),
    );
    const parsed = await gateway().parseWebhook(body, headers);
    expect(parsed).toMatchObject({
      kind: 'payment',
      eventId: 'evt_1',
      payment: {
        providerRef: 'pi_123',
        status: 'SUCCEEDED',
        amountCents: 10000,
        currency: 'USD',
        metadata: { paymentId: 'p-1' },
      },
    });
  });

  it('maps failures, cancellations and 3DS', async () => {
    const g = gateway();
    const failed = signed(
      event(
        'payment_intent.payment_failed',
        intent({
          status: 'requires_payment_method',
          last_payment_error: {
            code: 'card_declined',
            decline_code: 'insufficient_funds',
            message: 'no',
          },
        }),
      ),
    );
    expect(await g.parseWebhook(failed.body, failed.headers)).toMatchObject({
      payment: { status: 'FAILED', failureCode: 'insufficient_funds' },
    });
    const canceled = signed(
      event('payment_intent.canceled', intent({ status: 'canceled' })),
    );
    expect(await g.parseWebhook(canceled.body, canceled.headers)).toMatchObject(
      {
        payment: { status: 'CANCELLED' },
      },
    );
    const action = signed(
      event(
        'payment_intent.requires_action',
        intent({ status: 'requires_action' }),
      ),
    );
    expect(await g.parseWebhook(action.body, action.headers)).toMatchObject({
      payment: { status: 'REQUIRES_ACTION' },
    });
  });

  it('normalizes refunds and disputes', async () => {
    const g = gateway();
    const refund = signed(
      event('refund.updated', {
        id: 're_1',
        object: 'refund',
        amount: 2500,
        payment_intent: 'pi_123',
        status: 'succeeded',
      }),
    );
    expect(await g.parseWebhook(refund.body, refund.headers)).toMatchObject({
      kind: 'refund',
      refund: {
        providerRef: 're_1',
        paymentProviderRef: 'pi_123',
        status: 'SUCCEEDED',
        amountCents: 2500,
      },
    });
    const dispute = signed(
      event('charge.dispute.created', {
        id: 'dp_1',
        object: 'dispute',
        amount: 10000,
        currency: 'usd',
        reason: 'fraudulent',
        status: 'needs_response',
        payment_intent: 'pi_123',
        evidence_details: { due_by: 1_800_000_000 },
      }),
    );
    expect(await g.parseWebhook(dispute.body, dispute.headers)).toMatchObject({
      kind: 'dispute',
      dispute: {
        providerRef: 'dp_1',
        paymentProviderRef: 'pi_123',
        status: 'OPEN',
        reason: 'fraudulent',
        evidenceDueAt: new Date(1_800_000_000 * 1000),
      },
    });
    const won = signed(
      event(
        'charge.dispute.closed',
        {
          id: 'dp_1',
          object: 'dispute',
          amount: 10000,
          currency: 'usd',
          status: 'won',
          payment_intent: 'pi_123',
        },
        'evt_2',
      ),
    );
    expect(await g.parseWebhook(won.body, won.headers)).toMatchObject({
      dispute: { status: 'WON' },
    });
  });

  it('ignores event types it does not handle', async () => {
    const { body, headers } = signed(
      event('customer.created', { id: 'cus_1' }),
    );
    expect(await gateway().parseWebhook(body, headers)).toMatchObject({
      kind: 'ignored',
    });
  });

  it('rejects a wrong secret, a tampered body, a missing header and a stale timestamp', async () => {
    const g = gateway();
    const ok = signed(event('payment_intent.succeeded', intent()));
    const wrong = signed(
      event('payment_intent.succeeded', intent()),
      'whsec_other',
    );
    await expect(
      g.parseWebhook(wrong.body, wrong.headers),
    ).rejects.toBeInstanceOf(InvalidWebhookSignatureError);
    await expect(
      g.parseWebhook(
        Buffer.from(ok.body.toString().replace('10000', '1')),
        ok.headers,
      ),
    ).rejects.toBeInstanceOf(InvalidWebhookSignatureError);
    await expect(g.parseWebhook(ok.body, {})).rejects.toBeInstanceOf(
      InvalidWebhookSignatureError,
    );
    const payload = JSON.stringify(event('payment_intent.succeeded', intent()));
    const old = stripe.webhooks.generateTestHeaderString({
      payload,
      secret: SECRET,
      timestamp: Math.floor(Date.now() / 1000) - 3600,
    });
    await expect(
      g.parseWebhook(Buffer.from(payload), { 'stripe-signature': old }),
    ).rejects.toBeInstanceOf(InvalidWebhookSignatureError);
  });

  it('is unavailable without a webhook secret', async () => {
    const { body, headers } = signed(
      event('payment_intent.succeeded', intent()),
    );
    await expect(
      gateway({ webhookSecret: '' }).parseWebhook(body, headers),
    ).rejects.toBeInstanceOf(GatewayNotConfiguredError);
  });
});

describe('StripeGateway API calls (local server)', () => {
  let server: Server;
  let port: number;
  const seen: {
    url?: string;
    headers: IncomingMessage['headers'];
    body: string;
  }[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        seen.push({ url: req.url, headers: req.headers, body });
        res.setHeader('content-type', 'application/json');
        if (req.url?.startsWith('/v1/refunds')) {
          res.end(
            JSON.stringify({
              id: 're_9',
              object: 'refund',
              amount: 500,
              payment_intent: 'pi_123',
              status: 'succeeded',
            }),
          );
        } else {
          res.end(
            JSON.stringify(intent({ status: 'requires_payment_method' })),
          );
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  const local = () =>
    gateway({ apiHost: { host: '127.0.0.1', port, protocol: 'http' } });

  it('creates a PaymentIntent in USD with automatic payment methods and an idempotency key', async () => {
    const created = await local().createPayment({
      paymentId: 'p-1',
      bookingReference: 'DST-1',
      amountCents: 10000,
      currency: 'USD',
      description: 'Desertica DST-1',
    });
    expect(created).toMatchObject({
      providerRef: 'pi_123',
      status: 'PENDING',
      clientSecret: 'pi_123_secret_abc',
    });
    const call = seen.find((c) => c.url === '/v1/payment_intents')!;
    const form = new URLSearchParams(call.body);
    expect(form.get('amount')).toBe('10000');
    expect(form.get('currency')).toBe('usd');
    expect(form.get('automatic_payment_methods[enabled]')).toBe('true');
    expect(form.get('metadata[paymentId]')).toBe('p-1');
    expect(call.headers['idempotency-key']).toBe('payment:p-1');
    expect(call.headers.authorization).toBe('Bearer sk_test_x');
  });

  it('refuses a non-USD charge before calling Stripe', async () => {
    const before = seen.length;
    await expect(
      local().createPayment({
        paymentId: 'p-2',
        bookingReference: 'x',
        amountCents: 100,
        currency: 'PEN',
        description: 'x',
      }),
    ).rejects.toMatchObject({ code: 'currency_unsupported' });
    expect(seen.length).toBe(before);
  });

  it('refunds against the original PaymentIntent with an idempotency key', async () => {
    const refund = await local().refund({
      refundId: 'r-1',
      paymentProviderRef: 'pi_123',
      amountCents: 500,
      currency: 'USD',
      reason: 'x',
    });
    expect(refund).toMatchObject({
      providerRef: 're_9',
      status: 'SUCCEEDED',
      paymentProviderRef: 'pi_123',
    });
    const call = seen.find((c) => c.url === '/v1/refunds')!;
    expect(new URLSearchParams(call.body).get('payment_intent')).toBe('pi_123');
    expect(call.headers['idempotency-key']).toBe('refund:r-1');
  });

  it('reports a missing configuration', async () => {
    await expect(
      gateway({ secretKey: '' }).retrievePayment('pi_1'),
    ).rejects.toBeInstanceOf(GatewayNotConfiguredError);
  });
});
