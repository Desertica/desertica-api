import { Global, Module, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import Redis from 'ioredis';
import { EnvVars } from '../../config/env.validation';
import { KEY_VALUE_STORE, KeyValueStore } from './key-value-store';
import { MemoryKeyValueStore } from './memory-key-value-store';
import { RedisKeyValueStore } from './redis-key-value-store';

@Global()
@Module({
  providers: [
    {
      provide: KEY_VALUE_STORE,
      inject: [ConfigService],
      useFactory: (config: ConfigService<EnvVars, true>): KeyValueStore => {
        const url = config.get('REDIS_URL', { infer: true });
        if (!url) return new MemoryKeyValueStore();
        return new RedisKeyValueStore(
          new Redis(url, { maxRetriesPerRequest: 2, lazyConnect: false }),
        );
      },
    },
  ],
  exports: [KEY_VALUE_STORE],
})
export class CacheModule implements OnApplicationShutdown {
  constructor(private readonly moduleRef: ModuleRef) {}

  onApplicationShutdown(): void {
    const store = this.moduleRef.get<KeyValueStore>(KEY_VALUE_STORE, {
      strict: false,
    });
    if (store instanceof RedisKeyValueStore) store.close();
  }
}
