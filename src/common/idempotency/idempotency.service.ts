import {
  HttpException,
  Injectable,
  UnprocessableEntityException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

export interface IdempotentResult<T> {
  status: number;
  body: T;
  /** `true` si se devolvió la respuesta guardada de una petición anterior. */
  replayed?: boolean;
}

/** JSON con claves ordenadas: el mismo cuerpo siempre da el mismo hash. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        )
      : v,
  );
}

export function hashRequest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

/**
 * `Idempotency-Key`: ejecuta `fn` una sola vez por `(scope, key)`.
 *
 * La fila de idempotencia y el efecto se confirman en la misma transacción, así
 * que no hay ventana en la que el efecto exista sin su respuesta guardada. Una
 * petición simultánea con la misma clave espera (por el índice único) a que la
 * primera confirme y entonces recibe la respuesta guardada. Reusar la clave con
 * un cuerpo distinto es un error 422.
 */
@Injectable()
export class IdempotencyService {
  constructor(private readonly prisma: PrismaService) {}

  async has(scope: string, key: string): Promise<boolean> {
    return (
      (await this.prisma.idempotencyRecord.count({ where: { scope, key } })) > 0
    );
  }

  async run<T>(
    options: {
      scope: string;
      key: string | undefined;
      request: unknown;
    },
    fn: (tx: Prisma.TransactionClient) => Promise<IdempotentResult<T>>,
  ): Promise<IdempotentResult<T>> {
    if (!options.key) {
      return this.prisma.$transaction(fn, { timeout: 20_000 });
    }
    const requestHash = hashRequest(options.request);
    const { scope, key } = options;

    return this.prisma.$transaction(
      async (tx) => {
        const inserted = await tx.$queryRaw<{ id: string }[]>`
          INSERT INTO "IdempotencyRecord" ("id", "scope", "key", "requestHash", "status")
          VALUES (gen_random_uuid()::text, ${scope}, ${key}, ${requestHash}, 0)
          ON CONFLICT ("scope", "key") DO NOTHING
          RETURNING "id"`;

        if (inserted.length === 0) {
          const existing = await tx.idempotencyRecord.findUniqueOrThrow({
            where: { scope_key: { scope, key } },
          });
          if (existing.requestHash !== requestHash) {
            throw new UnprocessableEntityException(
              'Idempotency-Key was already used with a different request',
            );
          }
          return {
            status: existing.status,
            body: existing.body as T,
            replayed: true,
          };
        }

        const result = await fn(tx);
        await tx.idempotencyRecord.update({
          where: { id: inserted[0].id },
          data: {
            status: result.status,
            body: result.body as Prisma.InputJsonValue,
          },
        });
        return result;
      },
      { timeout: 20_000 },
    );
  }
}

export function isHttpException(e: unknown): e is HttpException {
  return e instanceof HttpException;
}
