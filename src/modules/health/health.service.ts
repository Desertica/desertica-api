import {
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  KEY_VALUE_STORE,
  type KeyValueStore,
} from '../../common/cache/key-value-store';
import { EnvVars } from '../../config/env.validation';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class HealthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<EnvVars, true>,
    @Inject(KEY_VALUE_STORE) private readonly store: KeyValueStore,
  ) {}

  live() {
    return { status: 'ok', service: 'desertica-api' } as const;
  }

  async ready() {
    const checks: Record<string, 'up' | 'down'> = {};

    try {
      await this.prisma.$queryRaw`SELECT 1`;
      checks.database = 'up';
    } catch {
      checks.database = 'down';
    }

    // Redis solo cuenta si está configurado; la memoria siempre responde.
    if (this.config.get('REDIS_URL', { infer: true })) {
      checks.redis = (await this.store.ping()) ? 'up' : 'down';
    }

    if (Object.values(checks).includes('down')) {
      throw new ServiceUnavailableException({
        message: 'Service not ready',
        details: checks,
      });
    }
    return { status: 'ready', ...checks };
  }
}
