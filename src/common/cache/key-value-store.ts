/**
 * Almacén clave-valor con TTL. Redis es opcional: sin `REDIS_URL` se usa la
 * implementación en memoria (desarrollo, pruebas y una sola instancia).
 */
export interface KeyValueStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlMs?: number): Promise<void>;
  del(key: string): Promise<void>;
  /** Incrementa un contador; el TTL se fija al crear la clave. Devuelve el valor nuevo. */
  incr(key: string, ttlMs: number): Promise<{ value: number; ttlMs: number }>;
  ping(): Promise<boolean>;
  readonly kind: 'memory' | 'redis';
}

export const KEY_VALUE_STORE = Symbol('KEY_VALUE_STORE');
