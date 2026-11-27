import { BillingError } from './billing-client';
import { HttpBillingClient } from './http-billing.client';

describe('HttpBillingClient.downloadFile', () => {
  const client = (body: Uint8Array, headers: Record<string, string> = {}) =>
    new HttpBillingClient(
      { baseUrl: 'http://billing', serviceToken: 't'.repeat(32) },
      () => Promise.resolve(new Response(body, { status: 200, headers })),
    );

  it('returns a normal file', async () => {
    const file = await client(new Uint8Array([1, 2, 3]), {
      'content-type': 'application/pdf',
    }).downloadFile('id', 'pdf');
    expect(file?.data).toHaveLength(3);
  });

  it('refuses a file larger than 10 MB, announced or not', async () => {
    const big = new Uint8Array(10 * 1024 * 1024 + 1);
    await expect(
      client(new Uint8Array(1), {
        'content-length': String(big.length),
      }).downloadFile('id', 'pdf'),
    ).rejects.toBeInstanceOf(BillingError);
    await expect(client(big).downloadFile('id', 'pdf')).rejects.toThrow(
      'Billing file too large',
    );
  });
});
