import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';
import { EnvVars } from '../config/env.validation';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  constructor(config: ConfigService<EnvVars, true>) {
    super({
      adapter: new PrismaPg({
        connectionString: config.get('DATABASE_URL', { infer: true }),
        max: config.get('DB_POOL_MAX', { infer: true }),
        connectionTimeoutMillis: config.get('DB_CONNECTION_TIMEOUT_MS', {
          infer: true,
        }),
        statement_timeout: config.get('DB_STATEMENT_TIMEOUT_MS', {
          infer: true,
        }),
        idle_in_transaction_session_timeout: config.get(
          'DB_IDLE_IN_TX_TIMEOUT_MS',
          { infer: true },
        ),
      }),
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
