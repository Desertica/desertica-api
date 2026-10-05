import { BillingError } from '../src/modules/billing/billing-client';
import type { EmitRequest } from '../src/modules/billing/billing-client';
import { HttpBillingClient } from '../src/modules/billing/http-billing.client';
import { ContractServer, startBillingServer } from './billing-contract-server';

const request = (over: Partial<EmitRequest> = {}): EmitRequest => ({
  externalId: '11111111-1111-4111-8111-111111111111',
  docType: 'BOLETA',
  series: 'B001',
  number: 1,
  issueDate: '2026-10-04',
  currency: 'PEN',
  igvRate: '0.1800',
  customer: { idDocType: 'DNI', idDocNumber: '12345678', name: 'Ana Pérez' },
  items: [
    {
      description: 'Tour',
      quantity: 1,
      unitPriceCents: 36000,
      totalCents: 36000,
    },
  ],
  totalCents: 36000,
  ...over,
});

describe('HttpBillingClient against a server that follows billing.yaml', () => {
  let server: ContractServer;
  let client: HttpBillingClient;

  beforeEach(async () => {
    server = await startBillingServer();
    client = new HttpBillingClient({
      baseUrl: server.url,
      serviceToken: server.token,
    });
  });
  afterEach(async () => {
    expect(server.violations).toEqual([]);
    await server.close();
  });

  it('emits, reads the status and downloads the files', async () => {
    const result = await client.emit(request());
    expect(result).toMatchObject({
      status: 'ACCEPTED',
      taxableCents: 30508,
      igvCents: 5492,
      totalCents: 36000,
      files: { xml: true, cdr: true, pdf: true },
    });
    expect(await client.getStatus(request().externalId)).toMatchObject({
      status: 'ACCEPTED',
    });
    const pdf = await client.downloadFile(request().externalId, 'pdf');
    expect(pdf?.contentType).toBe('application/pdf');
    expect(pdf?.data.toString()).toContain('%PDF');
    expect(
      (await client.downloadFile(request().externalId, 'xml'))?.contentType,
    ).toBe('application/xml');
    expect(
      (await client.downloadFile(request().externalId, 'cdr'))?.contentType,
    ).toBe('application/zip');
    expect(
      await client.downloadFile('22222222-2222-4222-8222-222222222222', 'pdf'),
    ).toBeNull();
    expect(
      await client.getStatus('22222222-2222-4222-8222-222222222222'),
    ).toBeNull();
  });

  it('sends the service token and is idempotent by externalId', async () => {
    const a = await client.emit(request());
    const b = await client.emit(request());
    expect(b).toEqual(a);
    expect(server.requests.every((r) => r.method)).toBe(true);
    const bad = new HttpBillingClient({
      baseUrl: server.url,
      serviceToken: 'wrong',
    });
    await expect(bad.emit(request())).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      httpStatus: 401,
      retryable: true,
    });
  });

  it('maps conflicts and validation errors as not retryable, and an unavailable SUNAT as retryable', async () => {
    await client.emit(request());
    await expect(
      client.emit(
        request({
          totalCents: 36000,
          items: [
            {
              description: 'Otro',
              quantity: 1,
              unitPriceCents: 36000,
              totalCents: 36000,
            },
          ],
        }),
      ),
    ).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
      httpStatus: 409,
      retryable: false,
    });
    await expect(
      client.emit(
        request({
          externalId: '33333333-3333-4333-8333-333333333333',
          number: 1,
        }),
      ),
    ).rejects.toMatchObject({ code: 'SERIES_NUMBER_IN_USE', retryable: false });
    await expect(
      client.emit(
        request({
          externalId: '44444444-4444-4444-8444-444444444444',
          number: 2,
          currency: 'USD',
        }),
      ),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      httpStatus: 422,
      retryable: false,
    });

    server.fake.failNext(
      new BillingError('SUNAT caído', 'SUNAT_UNAVAILABLE', 502, true),
    );
    await expect(
      client.emit(
        request({
          externalId: '55555555-5555-4555-8555-555555555555',
          number: 3,
        }),
      ),
    ).rejects.toMatchObject({
      code: 'SUNAT_UNAVAILABLE',
      httpStatus: 502,
      retryable: true,
    });
  });

  it('voids through a ticket that SUNAT resolves later', async () => {
    await client.emit(request());
    server.fake.pendingPolls = 1;
    const started = await client.void(request().externalId, {
      reason: 'Error de digitación',
      voidDate: '2026-10-04',
    });
    expect(started.status).toBe('PENDING');
    expect((await client.getTicket(started.ticket))?.status).toBe('PENDING');
    expect(await client.getTicket(started.ticket)).toMatchObject({
      status: 'ACCEPTED',
    });
    expect(await client.getStatus(request().externalId)).toMatchObject({
      status: 'VOIDED',
    });
    expect(await client.getTicket('nope')).toBeNull();
    await expect(
      client.void('66666666-6666-4666-8666-666666666666', {
        reason: 'x',
        voidDate: '2026-10-04',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('treats an unreachable server as retryable', async () => {
    const dead = new HttpBillingClient({
      baseUrl: 'http://127.0.0.1:9',
      serviceToken: 'x',
      timeoutMs: 500,
    });
    await expect(dead.emit(request())).rejects.toMatchObject({
      code: 'UNREACHABLE',
      retryable: true,
    });
  });
});
