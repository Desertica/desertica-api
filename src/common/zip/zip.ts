import { crc32, deflateRawSync } from 'node:zlib';

export interface ZipEntry {
  /** Ruta dentro del ZIP, con `/` como separador. */
  name: string;
  data: Buffer;
}

/** Fecha fija de las entradas: el mismo contenido da el mismo ZIP. */
const DOS_TIME = 0;
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;

/**
 * ZIP mínimo (formato clásico, sin ZIP64: hasta 65 535 entradas y 4 GB), con
 * nombres en UTF-8 y compresión deflate. Evita una dependencia para un solo
 * uso: el paquete de evidencia de disputas.
 */
export function buildZip(entries: ZipEntry[]): Buffer {
  if (entries.length > 0xffff) throw new Error('Too many entries for a ZIP');
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    if (entry.name.startsWith('/') || entry.name.includes('..')) {
      throw new Error(`Unsafe ZIP entry name: ${entry.name}`);
    }
    const name = Buffer.from(entry.name, 'utf8');
    const compressed = deflateRawSync(entry.data);
    const [method, body] =
      compressed.length < entry.data.length
        ? ([8, compressed] as const)
        : ([0, entry.data] as const);
    const crc = crc32(entry.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // versión mínima
    local.writeUInt16LE(0x0800, 6); // nombres UTF-8
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // versión que lo creó
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + body.length;
  }

  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}
