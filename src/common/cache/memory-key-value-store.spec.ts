import { KeyValueThrottlerStorage } from './kv-throttler-storage';
import { MemoryKeyValueStore } from './memory-key-value-store';

describe('MemoryKeyValueStore', () => {
  it('expires keys by TTL', async () => {
    let now = 1000;
    const store = new MemoryKeyValueStore(() => now);
    await store.set('a', '1', 500);
    expect(await store.get('a')).toBe('1');
    now += 501;
    expect(await store.get('a')).toBeNull();
  });

  it('counts within a window and restarts after it', async () => {
    let now = 0;
    const store = new MemoryKeyValueStore(() => now);
    expect((await store.incr('c', 1000)).value).toBe(1);
    expect((await store.incr('c', 1000)).value).toBe(2);
    now += 1001;
    expect((await store.incr('c', 1000)).value).toBe(1);
  });
});

describe('KeyValueThrottlerStorage', () => {
  it('blocks after the limit and reports hits', async () => {
    const storage = new KeyValueThrottlerStorage(new MemoryKeyValueStore());
    const hit = () => storage.increment('1.2.3.4', 60000, 2, 0, 'default');
    expect((await hit()).isBlocked).toBe(false);
    expect((await hit()).isBlocked).toBe(false);
    const third = await hit();
    expect(third.isBlocked).toBe(true);
    expect(third.totalHits).toBe(3);
  });

  it('keeps tracking separate keys independently', async () => {
    const storage = new KeyValueThrottlerStorage(new MemoryKeyValueStore());
    await storage.increment('a', 60000, 1, 0, 'default');
    await storage.increment('a', 60000, 1, 0, 'default');
    expect(
      (await storage.increment('b', 60000, 1, 0, 'default')).isBlocked,
    ).toBe(false);
  });
});
