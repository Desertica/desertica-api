/**
 * Migración única: copia al bucket los comprobantes del directorio local.
 *   npm run documents:migrate-to-s3 -- --dry-run
 * Usa DOCUMENT_STORAGE_DIR y las variables DOCUMENT_S3_*.
 */
import 'dotenv/config';
import { envSchema, type EnvVars } from '../config/env.validation';
import { S3DocumentStorage } from '../modules/billing/document-storage';
import { migrateDocuments } from '../modules/billing/migrate-documents';

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const result = envSchema.validate(
    { ...process.env, DOCUMENT_STORAGE: 's3' },
    { allowUnknown: true },
  );
  if (result.error) throw result.error;
  const env = result.value as EnvVars;
  const report = await migrateDocuments(
    env.DOCUMENT_STORAGE_DIR,
    S3DocumentStorage.fromOptions({
      bucket: env.DOCUMENT_S3_BUCKET,
      endpoint: env.DOCUMENT_S3_ENDPOINT,
      region: env.DOCUMENT_S3_REGION,
      accessKeyId: env.DOCUMENT_S3_ACCESS_KEY_ID,
      secretAccessKey: env.DOCUMENT_S3_SECRET_ACCESS_KEY,
    }),
    dryRun,
  );
  for (const key of report.copied)
    console.log(`${dryRun ? 'copiaría' : 'copiado'}  ${key}`);
  for (const key of report.conflicts)
    console.log(
      `CONFLICTO (en el bucket con otro contenido, no se tocó)  ${key}`,
    );
  console.log(
    `${dryRun ? '[simulación] ' : ''}${report.copied.length} ${dryRun ? 'por copiar' : 'copiados'}, ` +
      `${report.alreadyThere.length} ya estaban, ${report.conflicts.length} conflictos.`,
  );
  if (report.conflicts.length) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
