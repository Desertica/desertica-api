import Redis from 'ioredis';
import { KeyValueStore } from './key-value-store';

export class RedisKeyValueStore implements KeyValueStore {
  readonly kind = 'redis' as const;

  constructor(private readonly redis: Redis) {}

  get(key: string): Promise<string | null> {
    return this.redis.get(key);
  }

  async set(key: string, value: string, ttlMs?: number): Promise<void> {
    if (ttlMs) await this.redis.set(key, value, 'PX', ttlMs);
    else await this.redis.set(key, value);
  }

  async del(key: string): Promise<void> {
    await this.redis.del(key);
  }

  async incr(
    key: string,
    ttlMs: number,
  ): Promise<{ value: number; ttlMs: number }> {
    // INCR + PEXPIRE NX atómicos; el TTL solo se fija al crear la clave.
    const result = (await this.redis.eval(
      `local v = redis.call('INCR', KEYS[1])
       if v == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
       return {v, redis.call('PTTL', KEYS[1])}`,
      1,
      key,
      ttlMs,
    )) as [number, number];
    return { value: result[0], ttlMs: Math.max(0, result[1]) };
  }

  async ping(): Promise<boolean> {
    try {
      return (await this.redis.ping()) === 'PONG';
    } catch {
      return false;
    }
  }

  close(): void {
    this.redis.disconnect();
  }
}
