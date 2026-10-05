import { crc32, inflateRawSync } from 'node:zlib';
import { buildZip } from './zip';

/** Lector mínimo (por el directorio central) para comprobar lo que se escribe. */
function readZip(zip: Buffer): Map<string, Buffer> {
  const eocd = zip.length - 22;
  expect(zip.readUInt32LE(eocd)).toBe(0x06054b50);
  const count = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  const files = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    expect(zip.readUInt32LE(p)).toBe(0x02014b50);
    const method = zip.readUInt16LE(p + 10);
    const crc = zip.readUInt32LE(p + 16);
    const compSize = zip.readUInt32LE(p + 20);
    const size = zip.readUInt32LE(p + 24);
    const nameLen = zip.readUInt16LE(p + 28);
    const local = zip.readUInt32LE(p + 42);
    const name = zip.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    const dataStart = local + 30 + zip.readUInt16LE(local + 26);
    const raw = zip.subarray(dataStart, dataStart + compSize);
    const data = method === 8 ? inflateRawSync(raw) : raw;
    expect(data.length).toBe(size);
    expect(crc32(data)).toBe(crc);
    files.set(name, Buffer.from(data));
    p += 46 + nameLen;
  }
  return files;
}

describe('buildZip', () => {
  it('round-trips text, empty and incompressible entries with UTF-8 names', () => {
    const random = Buffer.from(
      Array.from({ length: 300 }, (_, i) => (i * 37 + 11) % 251),
    );
    const zip = buildZip([
      { name: 'a.txt', data: Buffer.from('hola '.repeat(500)) },
      { name: 'politicas/términos-v1.md', data: Buffer.from('# Términos') },
      { name: 'vacio.txt', data: Buffer.alloc(0) },
      { name: 'binario.bin', data: random },
    ]);
    const files = readZip(zip);
    expect([...files.keys()]).toEqual([
      'a.txt',
      'politicas/términos-v1.md',
      'vacio.txt',
      'binario.bin',
    ]);
    expect(files.get('a.txt')!.toString()).toBe('hola '.repeat(500));
    expect(files.get('politicas/términos-v1.md')!.toString()).toBe(
      '# Términos',
    );
    expect(files.get('vacio.txt')!.length).toBe(0);
    expect(files.get('binario.bin')!.equals(random)).toBe(true);
  });

  it('is deterministic and rejects unsafe names', () => {
    const entries = [{ name: 'x.txt', data: Buffer.from('x') }];
    expect(buildZip(entries).equals(buildZip(entries))).toBe(true);
    expect(() => buildZip([{ name: '../x', data: Buffer.alloc(0) }])).toThrow();
    expect(() => buildZip([{ name: '/x', data: Buffer.alloc(0) }])).toThrow();
  });
});
