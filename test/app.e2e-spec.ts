import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/common/configure-app';

describe('Desértica API (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /health', () => {
    return request(app.getHttpServer())
      .get('/health')
      .expect(200)
      .expect({ status: 'ok', service: 'desertica-api' });
  });

  it('creates, lists and deletes a tour', async () => {
    const slug = `tour-e2e-${Date.now()}`;

    const created = await request(app.getHttpServer())
      .post('/api/tours')
      .send({
        slug,
        title: 'Tour e2e',
        description: 'Creado por la suite e2e',
        priceCents: 50000,
        durationHours: 2,
        isPublished: false,
      })
      .expect(201);

    expect(created.body).toMatchObject({
      slug,
      title: 'Tour e2e',
      priceCents: 50000,
    });

    const createdBody = created.body as { id: string; slug: string };
    const list = await request(app.getHttpServer())
      .get('/api/tours')
      .expect(200);
    const tours = list.body as Array<{ slug: string }>;

    expect(tours.some((item) => item.slug === slug)).toBe(true);

    await request(app.getHttpServer())
      .delete(`/api/tours/${createdBody.id}`)
      .expect(200);
  });
});
