import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * Almacenamiento de los archivos de comprobantes (XML, CDR, PDF). Hoy un
 * directorio local; un S3 compatible implementa la misma interfaz después.
 * Nunca en Git y con retención legal: no hay operación de borrado.
 */
export interface DocumentStorage {
  put(key: string, data: Buffer): Promise<void>;
  /** `null` si no existe. */
  get(key: string): Promise<Buffer | null>;
}

export const DOCUMENT_STORAGE = Symbol('DOCUMENT_STORAGE');

const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9/_.-]*$/;

export class LocalDocumentStorage implements DocumentStorage {
  private readonly root: string;

  constructor(directory: string) {
    this.root = resolve(directory);
  }

  private path(key: string): string {
    if (!SAFE_KEY.test(key) || key.includes('..') || key.includes('//')) {
      throw new Error(`Unsafe storage key: ${key}`);
    }
    const full = resolve(join(this.root, key));
    if (!full.startsWith(this.root + sep)) {
      throw new Error(`Unsafe storage key: ${key}`);
    }
    return full;
  }

  async put(key: string, data: Buffer): Promise<void> {
    const target = this.path(key);
    await mkdir(dirname(target), { recursive: true });
    // Escritura atómica: nadie lee un archivo a medias.
    const temp = `${target}.${randomUUID()}.tmp`;
    await writeFile(temp, data);
    await rename(temp, target);
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      return await readFile(this.path(key));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }
}

/** Almacenamiento en memoria para pruebas. */
export class MemoryDocumentStorage implements DocumentStorage {
  readonly files = new Map<string, Buffer>();
  put(key: string, data: Buffer): Promise<void> {
    this.files.set(key, data);
    return Promise.resolve();
  }
  get(key: string): Promise<Buffer | null> {
    return Promise.resolve(this.files.get(key) ?? null);
  }
}
