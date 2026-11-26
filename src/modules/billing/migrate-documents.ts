import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { DocumentExistsError, type DocumentStorage } from './document-storage';

export interface MigrationReport {
  copied: string[];
  alreadyThere: string[];
  /** Ya existen en el destino con otro contenido: no se tocan. */
  conflicts: string[];
}

/**
 * Copia al destino los comprobantes de un directorio local. Idempotente: lo
 * que ya está igual se salta y nunca sobrescribe. Con `dryRun` solo informa.
 */
export async function migrateDocuments(
  directory: string,
  target: DocumentStorage,
  dryRun: boolean,
): Promise<MigrationReport> {
  const report: MigrationReport = {
    copied: [],
    alreadyThere: [],
    conflicts: [],
  };
  let entries: string[];
  try {
    entries = await readdir(directory, { recursive: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return report;
    throw error;
  }
  for (const entry of entries.sort()) {
    if (entry.endsWith('.tmp')) continue; // restos de una escritura a medias
    const path = join(directory, entry);
    let data: Buffer;
    try {
      data = await readFile(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EISDIR') continue;
      throw error;
    }
    const key = relative(directory, path).split(sep).join('/');
    const existing = await target.get(key);
    if (existing) {
      (existing.equals(data) ? report.alreadyThere : report.conflicts).push(
        key,
      );
      continue;
    }
    if (!dryRun) {
      try {
        await target.put(key, data);
      } catch (error) {
        if (!(error instanceof DocumentExistsError)) throw error;
        report.conflicts.push(key);
        continue;
      }
    }
    report.copied.push(key);
  }
  return report;
}
