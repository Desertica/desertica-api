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
      .get('/api/health')
      .expect(200)
      .expect({ status: 'ok', service: 'desertica-api' });
  });

  it('GET /api/health/ready checks the database', () => {
    return request(app.getHttpServer())
      .get('/api/health/ready')
      .expect(200)
      .expect({ status: 'ready', database: 'up' });
  });

  it('sets security headers and no x-powered-by', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/health')
      .expect(200);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-request-id']).toBeDefined();
  });

  it('answers CORS only for listed origins', async () => {
    const allowed = await request(app.getHttpServer())
      .get('/api/health')
      .set('Origin', 'http://localhost:4200');
    expect(allowed.headers['access-control-allow-origin']).toBe(
      'http://localhost:4200',
    );
    const denied = await request(app.getHttpServer())
      .get('/api/health')
      .set('Origin', 'https://evil.example');
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('returns errors in the contract shape', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/does-not-exist')
      .expect(404);
    expect(res.body).toMatchObject({
      statusCode: 404,
      error: 'Not Found',
    });
    expect((res.body as { message?: string }).message).toBeDefined();
  });
});
