import { KeyValueStore } from './key-value-store';

interface Entry {
  value: string;
  expiresAt: number | null;
}

export class MemoryKeyValueStore implements KeyValueStore {
  readonly kind = 'memory' as const;
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly now: () => number = Date.now) {}

  private live(key: string): Entry | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt !== null && entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }

  get(key: string): Promise<string | null> {
    return Promise.resolve(this.live(key)?.value ?? null);
  }

  set(key: string, value: string, ttlMs?: number): Promise<void> {
    this.entries.set(key, {
      value,
      expiresAt: ttlMs ? this.now() + ttlMs : null,
    });
    return Promise.resolve();
  }

  del(key: string): Promise<void> {
    this.entries.delete(key);
    return Promise.resolve();
  }

  incr(key: string, ttlMs: number): Promise<{ value: number; ttlMs: number }> {
    const entry = this.live(key);
    if (!entry) {
      this.entries.set(key, { value: '1', expiresAt: this.now() + ttlMs });
      return Promise.resolve({ value: 1, ttlMs });
    }
    const value = Number(entry.value) + 1;
    entry.value = String(value);
    return Promise.resolve({
      value,
      ttlMs: Math.max(0, (entry.expiresAt ?? this.now()) - this.now()),
    });
  }

  ping(): Promise<boolean> {
    return Promise.resolve(true);
  }
}
