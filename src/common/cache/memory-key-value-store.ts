import { KeyValueStore } from './key-value-store';

interface Entry {
  value: string;
  expiresAt: number | null;
}

export class MemoryKeyValueStore implements KeyValueStore {
  readonly kind = 'memory' as const;
  private readonly entries = new Map<string, Entry>();

  private static readonly MAX_ENTRIES = 50_000;

  constructor(private readonly now: () => number = Date.now) {}

  /** Quita lo vencido; si aun así hay demasiado, descarta lo más antiguo. */
  private compact(): void {
    if (this.entries.size < MemoryKeyValueStore.MAX_ENTRIES) return;
    for (const key of [...this.entries.keys()]) this.live(key);
    for (const key of this.entries.keys()) {
      if (this.entries.size < MemoryKeyValueStore.MAX_ENTRIES * 0.9) break;
      this.entries.delete(key);
    }
  }

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
    this.compact();
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
      this.compact();
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
