import { ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { KEY_VALUE_STORE } from '../../common/cache/key-value-store';
import { PrismaService } from '../../prisma/prisma.service';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';

async function build(options: {
  dbOk: boolean;
  redisUrl?: string;
  redisOk?: boolean;
}) {
  const module = await Test.createTestingModule({
    controllers: [HealthController],
    providers: [
      HealthService,
      {
        provide: PrismaService,
        useValue: {
          $queryRaw: options.dbOk
            ? jest.fn().mockResolvedValue([{ '?column?': 1 }])
            : jest.fn().mockRejectedValue(new Error('down')),
        },
      },
      {
        provide: ConfigService,
        useValue: { get: () => options.redisUrl },
      },
      {
        provide: KEY_VALUE_STORE,
        useValue: { ping: () => Promise.resolve(options.redisOk ?? true) },
      },
    ],
  }).compile();
  return module.get(HealthController);
}

describe('HealthController', () => {
  it('returns a liveness payload', async () => {
    const controller = await build({ dbOk: true });
    expect(controller.live()).toEqual({
      status: 'ok',
      service: 'desertica-api',
    });
  });

  it('is ready when the database answers', async () => {
    const controller = await build({ dbOk: true });
    await expect(controller.ready()).resolves.toEqual({
      status: 'ready',
      database: 'up',
    });
  });

  it('fails readiness with 503 when the database is down', async () => {
    const controller = await build({ dbOk: false });
    await expect(controller.ready()).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('checks redis only when configured', async () => {
    const up = await build({
      dbOk: true,
      redisUrl: 'redis://x',
      redisOk: true,
    });
    await expect(up.ready()).resolves.toMatchObject({ redis: 'up' });
    const down = await build({
      dbOk: true,
      redisUrl: 'redis://x',
      redisOk: false,
    });
    await expect(down.ready()).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});
