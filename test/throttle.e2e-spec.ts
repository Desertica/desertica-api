import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import type { AppModule as AppModuleType } from '../src/app.module';
import { configureApp } from '../src/common/configure-app';

describe('Rate limit (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    process.env.THROTTLE_LIMIT = '3';
    // AppModule lee el entorno al importarse, así que se importa después de fijarlo.
    const appModule = (await import('../src/app.module.js')) as {
      AppModule: typeof AppModuleType;
    };
    const moduleFixture = await Test.createTestingModule({
      imports: [appModule.AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    delete process.env.THROTTLE_LIMIT;
    await app.close();
  });

  it('answers 429 in the error shape after the per-IP limit', async () => {
    const server = app.getHttpServer();
    for (let i = 0; i < 3; i++) {
      await request(server).get('/api/auth/me').expect(401);
    }
    const res = await request(server).get('/api/auth/me').expect(429);
    const body = res.body as { statusCode: number; error: string };
    expect(body.statusCode).toBe(429);
    expect(typeof body.error).toBe('string');
  });

  it('never throttles health probes', async () => {
    for (let i = 0; i < 6; i++) {
      await request(app.getHttpServer()).get('/api/health').expect(200);
    }
  });
});
