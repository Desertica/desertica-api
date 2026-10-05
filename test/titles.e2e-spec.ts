import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { CmsClient } from '../src/modules/cms/cms.client';
import { createCatalog, CatalogFixture } from './fixtures';
import { createTestApp, loginAs, TestSession } from './helpers';

type Body = Record<string, any>;

describe('Tour titles by Accept-Language (e2e)', () => {
  let app: INestApplication<App>;
  let admin: TestSession;
  let fx: CatalogFixture;
  let cmsFails = false;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await createTestApp((builder) =>
      builder.overrideProvider(CmsClient).useValue({
        listTours: ({ locale }: { locale?: string } = {}) => {
          if (cmsFails) return Promise.reject(new Error('CMS down'));
          // Solo el tour de la prueba tiene título en español.
          return Promise.resolve(
            locale === 'es' && fx
              ? [
                  {
                    slug: fx.tour.slug,
                    title: 'Buggy en las dunas',
                    durationHours: 2,
                  },
                ]
              : [],
          );
        },
        getPage: () => Promise.resolve(null),
      }),
    );
    admin = await loginAs(app, 'admin');
    fx = await createCatalog(app);
  });
  afterAll(async () => {
    await app.close();
  });

  const titleOf = async (language?: string) => {
    const dep = await fx.departure();
    const req = http().get(`/api/departures/${dep.id}`).set(admin.auth);
    const res = await (
      language ? req.set('Accept-Language', language) : req
    ).expect(200);
    return (res.body as Body).tourTitle as string;
  };

  it('answers in the requested language with English as the fallback', async () => {
    expect(await titleOf('es-PE,es;q=0.9')).toBe('Buggy en las dunas');
    expect(await titleOf('en')).toBe(`Fixture ${fx.tour.slug}`);
    expect(await titleOf()).toBe(`Fixture ${fx.tour.slug}`);
    expect(await titleOf('fr-FR,fr;q=0.9')).toBe(`Fixture ${fx.tour.slug}`);
  });

  it('falls back to English when the CMS is down', async () => {
    cmsFails = true;
    try {
      expect(await titleOf('es')).toBe(`Fixture ${fx.tour.slug}`);
    } finally {
      cmsFails = false;
    }
  });
});
