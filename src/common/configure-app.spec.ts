import { Controller, Get, INestApplication, Req } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { Request } from 'express';
import request from 'supertest';
import { App } from 'supertest/types';
import { configureApp } from './configure-app';

@Controller()
class WhoAmIController {
  @Get('whoami')
  whoami(@Req() req: Request) {
    return { ip: req.ip };
  }
}

async function appWith(
  config: Record<string, unknown>,
): Promise<INestApplication<App>> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        ignoreEnvFile: true,
        isGlobal: true,
        load: [() => ({ CORS_ORIGINS: '', NODE_ENV: 'test', ...config })],
      }),
    ],
    controllers: [WhoAmIController],
  }).compile();
  const app = moduleRef.createNestApplication<INestApplication<App>>();
  configureApp(app);
  await app.init();
  return app;
}

describe('configureApp: client IP and TRUST_PROXY', () => {
  const ipFor = async (hops: number, forwarded?: string) => {
    const app = await appWith({ TRUST_PROXY: hops });
    try {
      const req = request(app.getHttpServer()).get('/api/whoami');
      const res = await (
        forwarded ? req.set('X-Forwarded-For', forwarded) : req
      ).expect(200);
      return (res.body as { ip: string }).ip;
    } finally {
      await app.close();
    }
  };
  const LOOPBACK = /^(::1|::ffff:127\.0\.0\.1|127\.0\.0\.1)$/;

  it('ignores X-Forwarded-For when no proxy is trusted', async () => {
    expect(await ipFor(0, '203.0.113.7')).toMatch(LOOPBACK);
    expect(await ipFor(0, '203.0.113.7, 198.51.100.1')).toMatch(LOOPBACK);
  });

  it('with one trusted hop takes the address the proxy appended, not what the client prepended', async () => {
    expect(await ipFor(1, '203.0.113.7')).toBe('203.0.113.7');
    // Un cliente que se inventa una IP delante no puede hacerse pasar por ella.
    expect(await ipFor(1, '10.9.9.9, 203.0.113.7')).toBe('203.0.113.7');
  });

  it('with two trusted hops (Cloudflare and Coolify) skips both proxies', async () => {
    expect(await ipFor(2, '203.0.113.7, 198.51.100.1')).toBe('203.0.113.7');
    expect(await ipFor(2, '10.9.9.9, 203.0.113.7, 198.51.100.1')).toBe(
      '203.0.113.7',
    );
  });

  it('falls back to the socket address when the header is shorter than the trusted chain', async () => {
    expect(await ipFor(3, '203.0.113.7')).toBe('203.0.113.7');
    expect(await ipFor(1)).toMatch(LOOPBACK);
  });
});
