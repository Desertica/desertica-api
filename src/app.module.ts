import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { CacheModule } from './common/cache/cache.module';
import { KEY_VALUE_STORE, KeyValueStore } from './common/cache/key-value-store';
import { KeyValueThrottlerStorage } from './common/cache/kv-throttler-storage';
import { buildLoggerParams } from './common/logger/logger.config';
import { EnvVars, envSchema } from './config/env.validation';
import { AuditModule } from './modules/audit/audit.module';
import { AuthGuard } from './modules/auth/auth.guard';
import { AuthModule } from './modules/auth/auth.module';
import { RolesModule } from './modules/roles/roles.module';
import { UsersModule } from './modules/users/users.module';
import { HealthModule } from './modules/health/health.module';
import { ToursModule } from './modules/tours/tours.module';
import { PrismaModule } from './prisma/prisma.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: envSchema,
      validationOptions: { abortEarly: false, allowUnknown: true },
    }),
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<EnvVars, true>) =>
        buildLoggerParams({
          level:
            config.get('NODE_ENV', { infer: true }) === 'test'
              ? 'silent'
              : config.get('LOG_LEVEL', { infer: true }),
          pretty: config.get('NODE_ENV', { infer: true }) === 'development',
        }),
    }),
    CacheModule,
    ThrottlerModule.forRootAsync({
      inject: [ConfigService, KEY_VALUE_STORE],
      useFactory: (
        config: ConfigService<EnvVars, true>,
        store: KeyValueStore,
      ) => ({
        throttlers: [
          {
            name: 'default',
            ttl: config.get('THROTTLE_TTL_MS', { infer: true }),
            limit: config.get('THROTTLE_LIMIT', { infer: true }),
          },
        ],
        storage: new KeyValueThrottlerStorage(store),
      }),
    }),
    PrismaModule,
    AuditModule,
    AuthModule,
    UsersModule,
    RolesModule,
    HealthModule,
    ToursModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
export class AppModule {}
