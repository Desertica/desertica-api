import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { CulqiGateway } from './culqi.gateway';
import {
  GatewayNotConfiguredError,
  InvalidWebhookSignatureError,
} from './payment-gateway';

interface ReqBody {
  source_id?: string;
  authentication_3DS?: unknown;
  amount?: string | number;
  currency_code?: string;
  metadata?: object;
  charge_id?: string;
  antifraud_details?: object;
}

describe('CulqiGateway (local server)', () => {
  let server: Server;
  let apiUrl: string;
  let charges: Record<string, object>;
  /** Devoluciones que "Culqi" conoce (`GET /v2/refunds/{id}`). */
  let refunds: Record<string, object>;
  let refundStatus: string | undefined;
  const seen: {
    method?: string;
    url?: string;
    headers: IncomingMessage['headers'];
    body: ReqBody;
  }[] = [];

  beforeEach(() => {
    charges = {};
    refunds = {};
    refundStatus = undefined;
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
          if (body.source_id === 'tkn_denied') {
            // Lo que trae el evento real `charge.creation.failed` de Culqi.
            res.statusCode = 402;
            return res.end(
              JSON.stringify({
                object: 'error',
                type: 'operacion_denegada',
                chargeId: 'chr_test_denied0000000001',
                code: 'DNGE0015',
                declineCode: 'insufficient_funds',
                merchantMessage: 'La operación fue denegada',
                userMessage: 'Su tarjeta no tiene fondos suficientes.',
              }),
            );
          }
          if (body.source_id === 'tkn_bad_request') {
            res.statusCode = 400;
            return res.end(
              JSON.stringify({
                object: 'error',
                type: 'invalid_request_error',
                merchant_message: 'Token inválido',
              }),
            );
          }
          if (body.source_id === 'tkn_3ds' && !body.authentication_3DS) {
            // Respuesta documentada: HTTP 200 (no 201) y sin objeto `charge`.
            res.statusCode = 200;
            return res.end(
              JSON.stringify({
                user_message: 'El usuario necesita autenticarse',
                action_code: 'REVIEW',
              }),
            );
          }
          res.statusCode = 201;
          const charge = {
            object: 'charge',
            id: 'chr_test_0000000000000001',
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
          if (req.headers.authorization !== 'Bearer sk_test_x') {
            res.statusCode = 401;
            return res.end(
              JSON.stringify({
                object: 'error',
                type: 'authentication_error',
                merchant_message: 'Ruta inválida',
              }),
            );
          }
          if (!found) {
            // Lo que responde Culqi real a un cargo bien formado que no existe.
            res.statusCode = 400;
            return res.end(
              JSON.stringify({
                object: 'error',
                type: 'parameter_error',
                code: 'CNP0002',
                merchant_message: 'No existe el cargo',
              }),
            );
          }
          return res.end(JSON.stringify(found));
        }
        if (req.method === 'GET' && req.url?.startsWith('/v2/refunds/')) {
          const found = refunds[req.url.split('/').pop()!];
          if (!found) {
            res.statusCode = 400;
            return res.end(
              JSON.stringify({ object: 'error', type: 'parameter_error' }),
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
              status: refundStatus,
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
      providerRef: 'chr_test_0000000000000001',
      status: 'SUCCEEDED',
      amountCents: 36000,
      currency: 'PEN',
      metadata: { paymentId: 'p-1' },
    });
    const call = seen[0];
    expect(call.headers.authorization).toBe('Bearer sk_test_x');
    expect(call.body).toMatchObject({
      amount: 36000,
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

  it('flags the real Culqi decline (402 operacion_denegada) with the message for the cardholder', async () => {
    await expect(
      gateway().createPayment(input({ token: 'tkn_denied' })),
    ).rejects.toMatchObject({
      declined: true,
      code: 'insufficient_funds',
      message: 'Su tarjeta no tiene fondos suficientes.',
      httpStatus: 402,
    });
  });

  it('a request Culqi refuses is not a decline but carries its status', async () => {
    await expect(
      gateway().createPayment(input({ token: 'tkn_bad_request' })),
    ).rejects.toMatchObject({ declined: false, httpStatus: 400 });
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

  it('sends the device id as antifraud_details.device_finger_print_id', async () => {
    await gateway().createPayment(input({ deviceId: 'dev-1' }));
    expect(seen[0].body.antifraud_details).toEqual({
      device_finger_print_id: 'dev-1',
    });
  });

  it('refunds against the charge', async () => {
    const refund = await gateway().refund({
      refundId: 'r-1',
      paymentProviderRef: 'chr_test_0000000000000001',
      amountCents: 500,
      currency: 'PEN',
      reason: 'x',
    });
    expect(refund).toMatchObject({
      providerRef: 'ref_1',
      status: 'SUCCEEDED',
      paymentProviderRef: 'chr_test_0000000000000001',
      amountCents: 500,
    });
    expect(seen[0].body).toMatchObject({ reason: 'solicitud_comprador' });
  });

  it.each([
    ['Pendiente', 'PENDING'],
    ['Rechazado', 'FAILED'],
    ['completa', 'SUCCEEDED'],
  ])('maps refund status %s to %s', async (status, expected) => {
    refundStatus = status;
    const refund = await gateway().refund({
      refundId: 'r-1',
      paymentProviderRef: 'chr_test_0000000000000001',
      amountCents: 500,
      currency: 'PEN',
      reason: 'x',
    });
    expect(refund.status).toBe(expected);
  });

  it('is unavailable without a key', async () => {
    await expect(
      gateway({ secretKey: '' }).createPayment(input()),
    ).rejects.toBeInstanceOf(GatewayNotConfiguredError);
  });

  describe('webhook', () => {
    const post = (body: object) =>
      gateway().parseWebhook(Buffer.from(JSON.stringify(body)));
    const urls = () => seen.map((r) => `${r.method} ${r.url}`);

    it('re-reads the charge from Culqi instead of trusting the body (data as a string)', async () => {
      await gateway().createPayment(input());
      const parsed = await post({
        object: 'event',
        id: 'evt_test_13QqJ1W6fKq6Gpbn',
        type: 'charge.creation.succeeded',
        // Lo que viene en el cuerpo no cuenta: ni el monto ni el estado.
        data: JSON.stringify({
          object: 'charge',
          id: 'chr_test_0000000000000001',
          amount: 1,
          paid: false,
        }),
      });
      expect(parsed).toMatchObject({
        kind: 'payment',
        eventId: 'evt_test_13QqJ1W6fKq6Gpbn',
        type: 'charge.creation.succeeded',
        payment: {
          providerRef: 'chr_test_0000000000000001',
          amountCents: 36000,
          status: 'SUCCEEDED',
        },
      });
      expect(urls()).toContain('GET /v2/charges/chr_test_0000000000000001');
      expect(urls().some((u) => u.includes('/events'))).toBe(false);
      expect(seen.at(-1)?.headers.authorization).toBe('Bearer sk_test_x');
    });

    it('accepts data as an object too', async () => {
      await gateway().createPayment(input());
      expect(
        await post({
          id: 'evt_test_0gFBZBiCOEmGngnr',
          type: 'charge.status.changed',
          data: { object: 'charge', id: 'chr_test_0000000000000001' },
        }),
      ).toMatchObject({ kind: 'payment', payment: { status: 'SUCCEEDED' } });
    });

    it('maps charge.creation.failed (data.object error) to the re-read charge, FAILED', async () => {
      charges.chr_test_PnktlQBA81JYsC4x = {
        object: 'charge',
        id: 'chr_test_PnktlQBA81JYsC4x',
        amount: 4500,
        currency_code: 'USD',
        paid: false,
        outcome: {
          type: 'operacion_denegada',
          code: 'DNGE0015',
          decline_code: 'insufficient_funds',
          user_message: 'Su tarjeta no tiene fondos suficientes.',
        },
        metadata: { paymentId: 'p-9' },
      };
      const parsed = await post({
        object: 'event',
        id: 'evt_test_Msdi1xucquFyahek',
        type: 'charge.creation.failed',
        data: JSON.stringify({
          object: 'error',
          type: 'operacion_denegada',
          chargeId: 'chr_test_PnktlQBA81JYsC4x',
          code: 'DNGE0015',
          declineCode: 'insufficient_funds',
          userMessage: 'Su tarjeta no tiene fondos suficientes.',
        }),
      });
      expect(parsed).toMatchObject({
        kind: 'payment',
        eventId: 'evt_test_Msdi1xucquFyahek',
        payment: {
          providerRef: 'chr_test_PnktlQBA81JYsC4x',
          status: 'FAILED',
          currency: 'USD',
          failureCode: 'insufficient_funds',
          metadata: { paymentId: 'p-9' },
        },
      });
    });

    it('a forged "failed" body cannot fail a charge that Culqi says is paid', async () => {
      await gateway().createPayment(input());
      expect(
        await post({
          id: 'evt_test_AAAAAAAAAAAAAAAA',
          type: 'charge.creation.failed',
          data: { object: 'error', chargeId: 'chr_test_0000000000000001' },
        }),
      ).toMatchObject({ payment: { status: 'SUCCEEDED' } });
    });

    it('re-reads refunds from Culqi', async () => {
      refunds.ref_test_9000000000000000 = {
        object: 'refund',
        id: 'ref_test_9000000000000000',
        charge_id: 'chr_test_0000000000000001',
        amount: 700,
        status: 'Completa',
      };
      expect(
        await post({
          id: 'evt_test_r000000000000000',
          type: 'refund.creation.succeeded',
          data: {
            object: 'refund',
            id: 'ref_test_9000000000000000',
            amount: 1,
          },
        }),
      ).toMatchObject({
        kind: 'refund',
        refund: {
          providerRef: 'ref_test_9000000000000000',
          paymentProviderRef: 'chr_test_0000000000000001',
          amountCents: 700,
          status: 'SUCCEEDED',
        },
      });
      expect(urls()).toContain('GET /v2/refunds/ref_test_9000000000000000');
    });

    it('rejects ids Culqi does not know (400), without a valid event id or a well-formed object id', async () => {
      for (const body of [
        {
          id: 'evt_test_forged0000000000',
          data: { object: 'charge', id: 'chr_test_forged000000000' },
        },
        {
          id: 'evt_test_forged0000000000',
          data: { object: 'error', chargeId: 'chr_test_forged000000000' },
        },
        {
          id: 'evt_test_forged0000000000',
          data: { object: 'refund', id: 'ref_test_forged000000000' },
        },
        {
          type: 'charge.creation.succeeded',
          data: { object: 'charge', id: 'chr_test_0000000000000001' },
        },
        {
          id: 'evt_test_noexiste123',
          data: { object: 'charge', id: 'chr_test_0000000000000001' },
        },
      ]) {
        await expect(post(body)).rejects.toBeInstanceOf(
          InvalidWebhookSignatureError,
        );
      }
      await expect(
        gateway().parseWebhook(Buffer.from('not json')),
      ).rejects.toBeInstanceOf(InvalidWebhookSignatureError);
    });

    it('does not ask Culqi for an object id with an unexpected format', async () => {
      for (const id of [
        '../charges/chr_test_0000000000000001',
        'chr_test_0000000000000001/../x',
        'evt_test_AAAAAAAAAAAAAAAA',
      ]) {
        await expect(
          post({
            id: 'evt_test_AAAAAAAAAAAAAAAA',
            data: { object: 'charge', id },
          }),
        ).rejects.toBeInstanceOf(InvalidWebhookSignatureError);
      }
      expect(seen.length).toBe(0);
    });

    it('does not hide a wrong secret key as a bad webhook', async () => {
      await expect(
        gateway({ secretKey: 'sk_test_wrong' }).parseWebhook(
          Buffer.from(
            JSON.stringify({
              id: 'evt_test_AAAAAAAAAAAAAAAA',
              data: { object: 'charge', id: 'chr_test_0000000000000001' },
            }),
          ),
        ),
      ).rejects.toMatchObject({ code: 'authentication_error' });
    });

    it('is unavailable without a secret key', async () => {
      await expect(
        gateway({ secretKey: '' }).parseWebhook(
          Buffer.from(
            JSON.stringify({
              id: 'evt_test_x000000000000000',
              data: { object: 'charge', id: 'chr_test_0000000000000001' },
            }),
          ),
        ),
      ).rejects.toBeInstanceOf(GatewayNotConfiguredError);
    });

    it('ignores events that point to nothing it handles, without asking Culqi', async () => {
      for (const data of [
        '{"object":"order","id":"ord_test_1"}',
        undefined,
        'not json',
      ]) {
        expect(
          await post({
            id: 'evt_test_o000000000000000',
            type: 'order.status.changed',
            data,
          }),
        ).toMatchObject({
          kind: 'ignored',
          eventId: 'evt_test_o000000000000000',
        });
      }
      expect(seen.length).toBe(0);
    });
  });
});
