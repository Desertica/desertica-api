import { redactUrl } from './logger.config';

describe('redactUrl', () => {
  it('masks payment link tokens, waiver tokens and signed-link signatures', () => {
    expect(redactUrl('/api/public/payment-links/abc123/stripe-intent')).toBe(
      '/api/public/payment-links/[redacted]/stripe-intent',
    );
    expect(redactUrl('/api/public/waivers/tok-9')).toBe(
      '/api/public/waivers/[redacted]',
    );
    expect(
      redactUrl('/api/public/documents/9f1c/pdf?exp=1790000000&sig=deadbeef01'),
    ).toBe('/api/public/documents/9f1c/pdf?exp=1790000000&sig=[redacted]');
    expect(redactUrl('/api/x?a=1&token=secret&b=2')).toBe(
      '/api/x?a=1&token=[redacted]&b=2',
    );
  });

  it('leaves ordinary URLs alone', () => {
    expect(redactUrl('/api/payments?status=SUCCEEDED&page=2')).toBe(
      '/api/payments?status=SUCCEEDED&page=2',
    );
    expect(redactUrl('/api/webhooks/stripe')).toBe('/api/webhooks/stripe');
  });
});
