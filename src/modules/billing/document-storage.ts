import { link, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  GetObjectCommand,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';

/**
 * Almacenamiento de los archivos de comprobantes (XML, CDR, PDF): un
 * directorio local o un bucket S3 compatible (R2) privado. Son evidencia
 * legal: no hay borrado y `put` nunca sobrescribe. Repetir `put` con el mismo
 * contenido es un no-op (el procesador puede reintentar); con otro contenido
 * lanza `DocumentExistsError`.
 */
export interface DocumentStorage {
  put(key: string, data: Buffer): Promise<void>;
  /** `null` si no existe. */
  get(key: string): Promise<Buffer | null>;
}

export const DOCUMENT_STORAGE = Symbol('DOCUMENT_STORAGE');

export class DocumentExistsError extends Error {
  constructor(key: string) {
    super(`Document already stored with different content: ${key}`);
  }
}

const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9/_.-]*$/;

function assertSafeKey(key: string): void {
  if (!SAFE_KEY.test(key) || key.includes('..') || key.includes('//')) {
    throw new Error(`Unsafe storage key: ${key}`);
  }
}

/** Ya hay algo en `key`: si es lo mismo no pasa nada, si no, error. */
async function sameOrThrow(
  storage: DocumentStorage,
  key: string,
  data: Buffer,
): Promise<void> {
  const existing = await storage.get(key);
  if (!existing?.equals(data)) throw new DocumentExistsError(key);
}

export class LocalDocumentStorage implements DocumentStorage {
  private readonly root: string;

  constructor(directory: string) {
    this.root = resolve(directory);
  }

  private path(key: string): string {
    assertSafeKey(key);
    const full = resolve(join(this.root, key));
    if (!full.startsWith(this.root + sep)) {
      throw new Error(`Unsafe storage key: ${key}`);
    }
    return full;
  }

  async put(key: string, data: Buffer): Promise<void> {
    const target = this.path(key);
    await mkdir(dirname(target), { recursive: true });
    // Atómica y sin sobrescribir: se escribe aparte y `link` falla si ya existe.
    const temp = `${target}.${randomUUID()}.tmp`;
    await writeFile(temp, data);
    try {
      await link(temp, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      await sameOrThrow(this, key, data);
    } finally {
      await unlink(temp);
    }
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

export interface S3DocumentStorageOptions {
  bucket: string;
  endpoint?: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/**
 * Bucket S3 compatible (Cloudflare R2). Privado: las descargas pasan por los
 * endpoints del API, nunca por URLs del bucket.
 */
export class S3DocumentStorage implements DocumentStorage {
  constructor(
    private readonly bucket: string,
    private readonly client: S3Client,
  ) {}

  static fromOptions(options: S3DocumentStorageOptions): S3DocumentStorage {
    return new S3DocumentStorage(
      options.bucket,
      new S3Client({
        endpoint: options.endpoint || undefined,
        region: options.region,
        // R2 y MinIO no usan subdominios por bucket.
        forcePathStyle: Boolean(options.endpoint),
        credentials: {
          accessKeyId: options.accessKeyId,
          secretAccessKey: options.secretAccessKey,
        },
      }),
    );
  }

  async put(key: string, data: Buffer): Promise<void> {
    assertSafeKey(key);
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: data,
          // Escritura condicional: el bucket rechaza (412) si la clave ya existe.
          IfNoneMatch: '*',
        }),
      );
    } catch (error) {
      if (!isStatus(error, 412) && !isStatus(error, 409)) throw error;
      await sameOrThrow(this, key, data);
    }
  }

  async get(key: string): Promise<Buffer | null> {
    assertSafeKey(key);
    try {
      const out = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      if (!out.Body) return null;
      return Buffer.from(await out.Body.transformToByteArray());
    } catch (error) {
      if (error instanceof NoSuchKey || isStatus(error, 404)) return null;
      throw error;
    }
  }
}

function isStatus(error: unknown, status: number): boolean {
  return (
    error instanceof S3ServiceException &&
    error.$metadata?.httpStatusCode === status
  );
}

/** Almacenamiento en memoria para pruebas. */
export class MemoryDocumentStorage implements DocumentStorage {
  readonly files = new Map<string, Buffer>();
  async put(key: string, data: Buffer): Promise<void> {
    if (this.files.has(key)) return sameOrThrow(this, key, data);
    this.files.set(key, data);
  }
  get(key: string): Promise<Buffer | null> {
    return Promise.resolve(this.files.get(key) ?? null);
  }
}
