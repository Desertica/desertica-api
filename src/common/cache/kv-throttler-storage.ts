import { ThrottlerStorage } from '@nestjs/throttler';
import { ThrottlerStorageRecord } from '@nestjs/throttler/dist/throttler-storage-record.interface';
import { KeyValueStore } from './key-value-store';

/**
 * Almacén del rate limit sobre `KeyValueStore`: en memoria para una instancia,
 * en Redis cuando hay varias.
 */
export class KeyValueThrottlerStorage implements ThrottlerStorage {
  constructor(private readonly store: KeyValueStore) {}

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    const blockKey = `throttle:block:${throttlerName}:${key}`;
    const blocked = await this.store.get(blockKey);
    if (blocked !== null) {
      return {
        totalHits: limit + 1,
        timeToExpire: 0,
        isBlocked: true,
        timeToBlockExpire: Math.ceil(blockDuration / 1000),
      };
    }

    const { value, ttlMs } = await this.store.incr(
      `throttle:${throttlerName}:${key}`,
      ttl,
    );
    const isBlocked = value > limit;
    if (isBlocked && blockDuration > 0) {
      await this.store.set(blockKey, '1', blockDuration);
    }
    return {
      totalHits: value,
      timeToExpire: Math.ceil(ttlMs / 1000),
      isBlocked,
      timeToBlockExpire: isBlocked ? Math.ceil(blockDuration / 1000) : 0,
    };
  }
}
