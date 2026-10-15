import { publicDocumentUrl, signLink, verifyLink } from './signed-link';

const SECRET = 'a-secret-of-at-least-32-characters-long';

describe('signed links', () => {
  const now = Date.UTC(2026, 9, 4);
  const exp = Math.floor(now / 1000) + 600;

  it('verifies a fresh signature for the same resource only', () => {
    const sig = signLink(SECRET, 'document:abc', exp);
    expect(verifyLink(SECRET, 'document:abc', exp, sig, now)).toBe(true);
    expect(verifyLink(SECRET, 'document:other', exp, sig, now)).toBe(false);
    expect(
      verifyLink(
        'another-secret-0123456789012345678901',
        'document:abc',
        exp,
        sig,
        now,
      ),
    ).toBe(false);
  });

  it('rejects an expired or altered expiry and malformed signatures', () => {
    const sig = signLink(SECRET, 'document:abc', exp);
    expect(verifyLink(SECRET, 'document:abc', exp, sig, now + 601_000)).toBe(
      false,
    );
    expect(verifyLink(SECRET, 'document:abc', exp + 1, sig, now)).toBe(false);
    expect(verifyLink(SECRET, 'document:abc', exp, 'zz', now)).toBe(false);
    expect(verifyLink(SECRET, 'document:abc', exp, '', now)).toBe(false);
    expect(verifyLink(SECRET, 'document:abc', Number.NaN, sig, now)).toBe(
      false,
    );
  });

  it('builds an absolute URL that carries its own expiry and signature', () => {
    const url = new URL(
      publicDocumentUrl('http://api.test/api/', SECRET, 'abc', 600, now),
    );
    expect(url.pathname).toBe('/api/public/documents/abc/pdf');
    expect(Number(url.searchParams.get('exp'))).toBe(exp);
    expect(
      verifyLink(
        SECRET,
        'document:abc',
        exp,
        url.searchParams.get('sig')!,
        now,
      ),
    ).toBe(true);
  });
});
