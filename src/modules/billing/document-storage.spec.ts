import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalDocumentStorage } from './document-storage';

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

  it('overwrites atomically and leaves no temporary files behind', async () => {
    await storage.put('a/b.xml', Buffer.from('1'));
    await storage.put('a/b.xml', Buffer.from('2'));
    expect((await storage.get('a/b.xml'))?.toString()).toBe('2');
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
