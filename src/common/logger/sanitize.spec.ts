import { describeError, redactEmails, redactUrl } from './sanitize';

describe('redactUrl', () => {
  it.each([
    [
      '/api/public/waivers/AbC_123-xyz/sign',
      '/api/public/waivers/[redacted]/sign',
    ],
    ['/api/public/waivers/AbC_123', '/api/public/waivers/[redacted]'],
    [
      '/api/public/payment-links/tok?x=1',
      '/api/public/payment-links/[redacted]?x=1',
    ],
    ['/api/public/holds/tok', '/api/public/holds/[redacted]'],
    [
      '/api/public/bookings/DST-1?token=secret&a=1',
      '/api/public/bookings/DST-1?token=[redacted]&a=1',
    ],
    ['/api/x?a=1&Key=zzz', '/api/x?a=1&Key=[redacted]'],
    ['/api/bookings/123/cancel', '/api/bookings/123/cancel'],
  ])('%s', (input, expected) => {
    expect(redactUrl(input)).toBe(expected);
  });
});

describe('describeError', () => {
  it('hides e-mail addresses in the message', () => {
    const text = describeError(
      new Error('550 5.1.1 <ana.perez+x@example.com> user unknown'),
    );
    expect(text).not.toContain('ana.perez');
    expect(text).toContain('[email]');
    expect(text).toContain('Error:');
  });

  it('withholds the message of Prisma errors but keeps name, code and frames', () => {
    class PrismaClientKnownRequestError extends Error {
      code = 'P2002';
    }
    const error = new PrismaClientKnownRequestError(
      'Invalid prisma.customer.create() invocation: email: "ana@example.com"',
    );
    const text = describeError(error);
    expect(text).not.toContain('ana@example.com');
    expect(text).toContain('PrismaClientKnownRequestError [P2002]');
    expect(text).toMatch(/\bat /);
  });

  it('copes with values that are not errors', () => {
    expect(describeError('boom')).toBe('non-error thrown');
  });

  it('redactEmails leaves other text alone', () => {
    expect(redactEmails('no mail here: a@b')).toBe('no mail here: a@b');
  });
});
