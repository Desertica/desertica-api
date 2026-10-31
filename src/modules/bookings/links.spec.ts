import { links } from './links';

describe('links', () => {
  const base = 'https://desertica.pe';

  it('prefixes the booking language', () => {
    expect(links.booking(base, 'es', 'DST-1', 'a b')).toBe(
      'https://desertica.pe/es/booking/DST-1?token=a%20b',
    );
    expect(links.waiver(base, 'en', 'tok')).toBe(
      'https://desertica.pe/en/waiver/tok',
    );
    expect(links.payment(base, 'es', 'tok')).toBe(
      'https://desertica.pe/es/pay/tok',
    );
  });

  it('reads the language of a regional locale and falls back to en', () => {
    expect(links.payment(base, 'es-PE', 'tok')).toBe(
      'https://desertica.pe/es/pay/tok',
    );
    expect(links.payment(base, 'fr', 'tok')).toBe(
      'https://desertica.pe/en/pay/tok',
    );
  });
});
