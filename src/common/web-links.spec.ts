import { webUrl } from './web-links';

describe('webUrl', () => {
  it.each([
    [
      'https://desertica.pe',
      'es',
      'booking/DS-1',
      'https://desertica.pe/es/booking/DS-1',
    ],
    [
      'https://desertica.pe/',
      'en',
      '/pay/tok?x=1',
      'https://desertica.pe/en/pay/tok?x=1',
    ],
    ['https://desertica.pe', 'es', '', 'https://desertica.pe/es/'],
  ])('%s %s %s', (base, locale, path, expected) => {
    expect(webUrl(base, locale, path)).toBe(expected);
  });

  it.each(['fr', 'ES', '', null, undefined, '../x'])(
    'falls back to en for %p',
    (locale) => {
      expect(webUrl('https://desertica.pe', locale, 'tours')).toBe(
        'https://desertica.pe/en/tours',
      );
    },
  );
});
