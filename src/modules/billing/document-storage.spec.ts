import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import {
  GetObjectCommand,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DocumentExistsError,
  LocalDocumentStorage,
  MemoryDocumentStorage,
  S3DocumentStorage,
} from './document-storage';
import { migrateDocuments } from './migrate-documents';

describe('LocalDocumentStorage', () => {
  let dir: string;
  let storage: LocalDocumentStorage;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'desertica-storage-'));
    storage = new LocalDocumentStorage(dir);
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('writes nested keys, reads them back and returns null for a missing one', async () => {
    await storage.put('documents/2026/abc.pdf', Buffer.from('%PDF'));
    expect((await storage.get('documents/2026/abc.pdf'))?.toString()).toBe(
      '%PDF',
    );
    expect(
      (await readFile(join(dir, 'documents/2026/abc.pdf'))).toString(),
    ).toBe('%PDF');
    expect(await storage.get('documents/2026/none.pdf')).toBeNull();
  });

  it('never overwrites: same content is a no-op, different content throws', async () => {
    await storage.put('a/b.xml', Buffer.from('1'));
    await storage.put('a/b.xml', Buffer.from('1'));
    await expect(storage.put('a/b.xml', Buffer.from('2'))).rejects.toThrow(
      DocumentExistsError,
    );
    expect((await storage.get('a/b.xml'))?.toString()).toBe('1');
    expect(await readdir(join(dir, 'a'))).toEqual(['b.xml']);
  });

  it.each([
    '../escape',
    'a/../../escape',
    '/etc/passwd',
    'a//b',
    '',
    '.hidden',
    'a b',
  ])('refuses the unsafe key %j', async (key) => {
    await expect(storage.put(key, Buffer.from('x'))).rejects.toThrow(/Unsafe/);
    await expect(storage.get(key)).rejects.toThrow(/Unsafe/);
  });
});

/** Bucket simulado: respeta `IfNoneMatch: '*'` como R2 (412 si ya existe). */
function fakeBucket() {
  const objects = new Map<string, Buffer>();
  const send = jest.fn((command: unknown) => {
    if (command instanceof PutObjectCommand) {
      const { Key, Body, IfNoneMatch } = command.input;
      if (IfNoneMatch === '*' && objects.has(Key!)) {
        return Promise.reject(
          new S3ServiceException({
            name: 'PreconditionFailed',
            $fault: 'client',
            $metadata: { httpStatusCode: 412 },
          }),
        );
      }
      objects.set(Key!, Body as Buffer);
      return Promise.resolve({});
    }
    if (command instanceof GetObjectCommand) {
      const data = objects.get(command.input.Key!);
      if (!data) {
        return Promise.reject(
          new NoSuchKey({
            message: 'missing',
            $metadata: { httpStatusCode: 404 },
          }),
        );
      }
      return Promise.resolve({
        Body: {
          transformToByteArray: () => Promise.resolve(new Uint8Array(data)),
        },
      });
    }
    return Promise.reject(new Error('unexpected command'));
  });
  return { objects, send, client: { send } as unknown as S3Client };
}

describe('S3DocumentStorage', () => {
  it('writes with If-None-Match, reads back and returns null for a missing key', async () => {
    const bucket = fakeBucket();
    const storage = new S3DocumentStorage('comprobantes', bucket.client);
    await storage.put('documents/2026/abc.pdf', Buffer.from('%PDF'));
    const put = bucket.send.mock.calls[0][0] as PutObjectCommand;
    expect(put.input).toMatchObject({
      Bucket: 'comprobantes',
      Key: 'documents/2026/abc.pdf',
      IfNoneMatch: '*',
    });
    expect((await storage.get('documents/2026/abc.pdf'))?.toString()).toBe(
      '%PDF',
    );
    expect(await storage.get('documents/2026/none.pdf')).toBeNull();
  });

  it('never overwrites: same content is a no-op, different content throws', async () => {
    const bucket = fakeBucket();
    const storage = new S3DocumentStorage('comprobantes', bucket.client);
    await storage.put('a/b.xml', Buffer.from('1'));
    await storage.put('a/b.xml', Buffer.from('1'));
    await expect(storage.put('a/b.xml', Buffer.from('2'))).rejects.toThrow(
      DocumentExistsError,
    );
    expect(bucket.objects.get('a/b.xml')?.toString()).toBe('1');
  });

  it('refuses unsafe keys without calling the bucket', async () => {
    const bucket = fakeBucket();
    const storage = new S3DocumentStorage('comprobantes', bucket.client);
    await expect(storage.put('../x', Buffer.from('x'))).rejects.toThrow(
      /Unsafe/,
    );
    await expect(storage.get('a//b')).rejects.toThrow(/Unsafe/);
    expect(bucket.send).not.toHaveBeenCalled();
  });
});

describe('migrateDocuments', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'desertica-migrate-'));
    await mkdir(join(dir, 'documents/2026'), { recursive: true });
    await writeFile(join(dir, 'documents/2026/a.pdf'), '%PDF a');
    await writeFile(join(dir, 'documents/2026/b.xml'), '<b/>');
    await writeFile(join(dir, 'documents/2026/c.xml'), '<local/>');
    await writeFile(join(dir, 'documents/2026/a.pdf.123.tmp'), 'half');
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('copies what is missing, skips what is equal, reports conflicts and is idempotent', async () => {
    const target = new MemoryDocumentStorage();
    target.files.set('documents/2026/b.xml', Buffer.from('<b/>'));
    target.files.set('documents/2026/c.xml', Buffer.from('<bucket/>'));

    const dry = await migrateDocuments(dir, target, true);
    expect(dry).toEqual({
      copied: ['documents/2026/a.pdf'],
      alreadyThere: ['documents/2026/b.xml'],
      conflicts: ['documents/2026/c.xml'],
    });
    expect(target.files.has('documents/2026/a.pdf')).toBe(false);

    expect(await migrateDocuments(dir, target, false)).toEqual(dry);
    expect(target.files.get('documents/2026/a.pdf')?.toString()).toBe('%PDF a');
    expect(target.files.get('documents/2026/c.xml')?.toString()).toBe(
      '<bucket/>',
    );

    const again = await migrateDocuments(dir, target, false);
    expect(again.copied).toEqual([]);
    expect(again.alreadyThere).toHaveLength(2);
  });

  it('does nothing when the directory does not exist', async () => {
    const report = await migrateDocuments(
      join(dir, 'nope'),
      new MemoryDocumentStorage(),
      false,
    );
    expect(report).toEqual({ copied: [], alreadyThere: [], conflicts: [] });
  });
});
