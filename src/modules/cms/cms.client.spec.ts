import { ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MemoryKeyValueStore } from '../../common/cache/memory-key-value-store';
import { CmsClient } from './cms.client';

function build(ttlSeconds = 300) {
  const config = {
    get: (key: string) =>
      ({
        CMS_URL: 'http://cms.test/',
        CMS_API_TOKEN: 'secret',
        CMS_CACHE_TTL_SECONDS: ttlSeconds,
      })[key],
  } as unknown as ConfigService<never, true>;
  return new CmsClient(config, new MemoryKeyValueStore());
}

function mockFetch(impl: (url: string, init: RequestInit) => unknown) {
  const spy = jest
    .spyOn(global, 'fetch')
    .mockImplementation(
      (url, init) =>
        impl(
          typeof url === 'string' ? url : (url as URL).href,
          init as RequestInit,
        ) as Promise<Response>,
    );
  return spy;
}

const ok = (data: unknown) =>
  Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve({ data }),
  });

afterEach(() => jest.restoreAllMocks());

describe('CmsClient', () => {
  const noOperationalData = {
    durationHours: null,
    format: null,
    languages: [],
    meeting: null,
    meetingPointUrl: null,
    latitude: null,
    longitude: null,
  };

  it('maps tours with the operational data the CMS still has and sends the token', async () => {
    const spy = mockFetch(() =>
      ok([
        {
          slug: 'dune-buggy',
          title: 'Dune Buggy',
          durationHours: 2,
          format: 'both',
          languages: ['es', 'EN', 'español', 7],
          meeting: ' Meet in Ica ',
          meetingPointUrl: 'https://maps.example/x',
          latitude: '-14.0875',
          longitude: -75.7626,
        },
        {
          slug: 'no-title',
          durationHours: null,
          format: 'group',
          meetingPointUrl: 'javascript:alert(1)',
          latitude: 91,
        },
        { title: 'no slug' },
      ]),
    );
    const tours = await build().listTours();
    expect(tours).toEqual([
      {
        slug: 'dune-buggy',
        title: 'Dune Buggy',
        durationHours: 2,
        format: 'BOTH',
        languages: ['es', 'en'],
        meeting: 'Meet in Ica',
        meetingPointUrl: 'https://maps.example/x',
        latitude: -14.0875,
        longitude: -75.7626,
      },
      { slug: 'no-title', title: 'no-title', ...noOperationalData },
    ]);
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url.startsWith('http://cms.test/api/tours?locale=en')).toBe(true);
    expect(url).toContain('=durationHours');
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Bearer secret',
    );
  });

  it('asks only for slug and title once the CMS no longer has the operational fields', async () => {
    // Strapi 5 responde 400 a un `fields[...]` que no existe.
    const spy = mockFetch((url) =>
      url.includes('durationHours')
        ? Promise.resolve({
            ok: false,
            status: 400,
            json: () => Promise.resolve({ error: { name: 'ValidationError' } }),
          })
        : ok([{ slug: 'dune-buggy', title: 'Dune Buggy' }]),
    );
    await expect(build().listTours({ locale: 'es' })).resolves.toEqual([
      { slug: 'dune-buggy', title: 'Dune Buggy', ...noOperationalData },
    ]);
    expect(spy).toHaveBeenCalledTimes(2);
    const retry = (spy.mock.calls[1] as [string])[0];
    expect(retry).toContain('locale=es');
    expect(retry).toContain('fields[0]=slug&fields[1]=title');
    expect(retry).not.toContain('fields[2]');
  });

  it('serves from cache within the TTL', async () => {
    const spy = mockFetch(() => ok([{ slug: 'a', title: 'A' }]));
    const cms = build();
    await cms.listTours();
    await cms.listTours();
    expect(spy).toHaveBeenCalledTimes(1);
    await cms.listTours({ fresh: true });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('falls back to the last good response when the CMS fails', async () => {
    let fail = false;
    mockFetch(() =>
      fail
        ? Promise.reject(new Error('down'))
        : ok([{ slug: 'a', title: 'A' }]),
    );
    const cms = build(0); // sin caché fresca
    await cms.listTours();
    fail = true;
    await expect(cms.listTours()).resolves.toHaveLength(1);
  });

  it('answers 503 when the CMS fails and nothing was cached', async () => {
    mockFetch(() =>
      Promise.resolve({
        ok: false,
        status: 500,
        json: () => Promise.resolve({}),
      }),
    );
    await expect(build().listTours()).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('returns a page body or null', async () => {
    mockFetch((url) =>
      url.includes('terms')
        ? ok([{ slug: 'terms', title: 'Terms', body: '# T' }])
        : ok([]),
    );
    const cms = build();
    await expect(cms.getPage('terms', 'es')).resolves.toEqual({
      slug: 'terms',
      title: 'Terms',
      body: '# T',
    });
    await expect(cms.getPage('privacy', 'es')).resolves.toBeNull();
  });
});
