import { createHmac } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { CulqiGateway } from './culqi.gateway';
import {
  GatewayNotConfiguredError,
  InvalidWebhookSignatureError,
} from './payment-gateway';

const SECRET = 'culqi-webhook-secret';

interface ReqBody {
  source_id?: string;
  authentication_3DS?: unknown;
  amount?: string | number;
  currency_code?: string;
  metadata?: object;
  charge_id?: string;
}

describe('CulqiGateway (local server)', () => {
  let server: Server;
  let apiUrl: string;
  let charges: Record<string, object>;
  const seen: {
    method?: string;
    url?: string;
    headers: IncomingMessage['headers'];
    body: ReqBody;
  }[] = [];

  beforeEach(() => {
    charges = {};
    seen.length = 0;
  });

  beforeAll(async () => {
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c: Buffer) => (raw += c.toString()));
      req.on('end', () => {
        const body = (raw ? JSON.parse(raw) : {}) as ReqBody;
        seen.push({
          method: req.method,
          url: req.url,
          headers: req.headers,
          body,
        });
        res.setHeader('content-type', 'application/json');
        if (req.method === 'POST' && req.url === '/v2/charges') {
          if (body.source_id === 'tkn_declined') {
            res.statusCode = 402;
            return res.end(
              JSON.stringify({
                object: 'error',
                type: 'card_error',
                code: 'card_declined',
                decline_code: 'insufficient_funds',
                user_message: 'Fondos insuficientes',
              }),
            );
          }
          if (body.source_id === 'tkn_3ds' && !body.authentication_3DS) {
            return res.end(
              JSON.stringify({ object: 'charge', action_code: 'REVIEW' }),
            );
          }
          const charge = {
            object: 'charge',
            id: 'chr_test_1',
            amount: Number(body.amount),
            currency: body.currency_code,
            paid: true,
            outcome: { type: 'venta_exitosa' },
            metadata: body.metadata,
            dispute: false,
          };
          charges[charge.id] = charge;
          return res.end(JSON.stringify(charge));
        }
        if (req.method === 'GET' && req.url?.startsWith('/v2/charges/')) {
          const found = charges[req.url.split('/').pop()!];
          if (!found) {
            res.statusCode = 404;
            return res.end(
              JSON.stringify({
                object: 'error',
                type: 'invalid_request_error',
                user_message: 'no existe',
              }),
            );
          }
          return res.end(JSON.stringify(found));
        }
        if (req.method === 'POST' && req.url === '/v2/refunds') {
          return res.end(
            JSON.stringify({
              object: 'refund',
              id: 'ref_1',
              charge_id: body.charge_id,
              amount: body.amount,
            }),
          );
        }
        res.statusCode = 404;
        res.end('{}');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v2`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  const gateway = (over = {}) =>
    new CulqiGateway({
      secretKey: 'sk_test_x',
      publicKey: 'pk_test_x',
      apiUrl,
      webhookSecret: SECRET,
      ...over,
    });

  const input = (over = {}) => ({
    paymentId: 'p-1',
    bookingReference: 'DST-1',
    amountCents: 36000,
    currency: 'PEN' as const,
    description: 'Desertica DST-1',
    token: 'tkn_ok',
    email: 'a@example.com',
    ...over,
  });

  it('creates a charge with the token, in the requested currency, authenticated with the secret key', async () => {
    const payment = await gateway().createPayment(input());
    expect(payment).toMatchObject({
      providerRef: 'chr_test_1',
      status: 'SUCCEEDED',
      amountCents: 36000,
      currency: 'PEN',
      metadata: { paymentId: 'p-1' },
    });
    const call = seen[0];
    expect(call.headers.authorization).toBe('Bearer sk_test_x');
    expect(call.body).toMatchObject({
      amount: '36000',
      currency_code: 'PEN',
      email: 'a@example.com',
      source_id: 'tkn_ok',
      capture: true,
    });
    expect(JSON.stringify(call.body)).not.toMatch(/card_number|cvv/);
  });

  it('charges USD too', async () => {
    const payment = await gateway().createPayment(
      input({ currency: 'USD', amountCents: 10000 }),
    );
    expect(payment).toMatchObject({ currency: 'USD', amountCents: 10000 });
  });

  it('flags a declined card as declined and requires a token', async () => {
    await expect(
      gateway().createPayment(input({ token: 'tkn_declined' })),
    ).rejects.toMatchObject({ declined: true, code: 'insufficient_funds' });
    await expect(
      gateway().createPayment(input({ token: undefined })),
    ).rejects.toMatchObject({ code: 'invalid' });
  });

  it('reports 3DS pending and sends the authentication on the retry', async () => {
    const first = await gateway().createPayment(input({ token: 'tkn_3ds' }));
    expect(first).toMatchObject({
      status: 'REQUIRES_ACTION',
      providerRef: '',
      action: { type: 'THREE_DS' },
    });
    const done = await gateway().createPayment(
      input({ token: 'tkn_3ds', authentication3DS: { eci: '05' } }),
    );
    expect(done.status).toBe('SUCCEEDED');
    expect(seen[1].body.authentication_3DS).toEqual({ eci: '05' });
  });

  it('refunds against the charge', async () => {
    const refund = await gateway().refund({
      refundId: 'r-1',
      paymentProviderRef: 'chr_test_1',
      amountCents: 500,
      currency: 'PEN',
      reason: 'x',
    });
    expect(refund).toMatchObject({
      providerRef: 'ref_1',
      status: 'SUCCEEDED',
      paymentProviderRef: 'chr_test_1',
      amountCents: 500,
    });
  });

  it('is unavailable without a key', async () => {
    await expect(
      gateway({ secretKey: '' }).createPayment(input()),
    ).rejects.toBeInstanceOf(GatewayNotConfiguredError);
  });

  describe('webhook', () => {
    const sign = (raw: string, secret = SECRET) =>
      createHmac('sha256', secret).update(raw).digest('hex');

    it('verifies the signature and re-reads the charge instead of trusting the body', async () => {
      await gateway().createPayment(input());
      const raw = JSON.stringify({
        object: 'event',
        id: 'evt_c1',
        type: 'charge.creation.succeeded',
        data: JSON.stringify({
          object: 'charge',
          id: 'chr_test_1',
          amount: 1,
          currency: 'PEN',
        }),
      });
      const parsed = await gateway().parseWebhook(Buffer.from(raw), {
        'x-culqi-signature': sign(raw),
      });
      // El monto del cuerpo (1) se ignora: manda el del cargo consultado (36000).
      expect(parsed).toMatchObject({
        kind: 'payment',
        eventId: 'evt_c1',
        payment: {
          providerRef: 'chr_test_1',
          amountCents: 36000,
          status: 'SUCCEEDED',
        },
      });
    });

    it('rejects a missing, wrong or tampered signature', async () => {
      const raw = JSON.stringify({
        object: 'event',
        id: 'evt_c2',
        type: 'x',
        data: {},
      });
      await expect(
        gateway().parseWebhook(Buffer.from(raw), {}),
      ).rejects.toBeInstanceOf(InvalidWebhookSignatureError);
      await expect(
        gateway().parseWebhook(Buffer.from(raw), {
          'x-culqi-signature': sign(raw, 'other'),
        }),
      ).rejects.toBeInstanceOf(InvalidWebhookSignatureError);
      await expect(
        gateway().parseWebhook(Buffer.from(raw + ' '), {
          'x-culqi-signature': sign(raw),
        }),
      ).rejects.toBeInstanceOf(InvalidWebhookSignatureError);
    });

    it('is unavailable without a webhook secret', async () => {
      await expect(
        gateway({ webhookSecret: '' }).parseWebhook(Buffer.from('{}'), {}),
      ).rejects.toBeInstanceOf(GatewayNotConfiguredError);
    });

    it('normalizes refund events and ignores the rest', async () => {
      const refundRaw = JSON.stringify({
        object: 'event',
        id: 'evt_r',
        type: 'refund.creation.succeeded',
        data: {
          object: 'refund',
          id: 'ref_9',
          charge_id: 'chr_x',
          amount: 700,
        },
      });
      expect(
        await gateway().parseWebhook(Buffer.from(refundRaw), {
          'x-culqi-signature': sign(refundRaw),
        }),
      ).toMatchObject({
        kind: 'refund',
        refund: {
          providerRef: 'ref_9',
          paymentProviderRef: 'chr_x',
          amountCents: 700,
        },
      });
      const otherRaw = JSON.stringify({
        object: 'event',
        type: 'order.status.changed',
        data: {},
      });
      expect(
        await gateway().parseWebhook(Buffer.from(otherRaw), {
          'x-culqi-signature': sign(otherRaw),
        }),
      ).toMatchObject({ kind: 'ignored' });
    });
  });
});
