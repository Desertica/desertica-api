import { Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import {
  Paginated,
  PaginationQuery,
  paginated,
  skipTake,
} from '../../common/pagination/pagination';
import { PrismaService } from '../../prisma/prisma.service';

export interface AuditEntry {
  actorUserId?: string | null;
  /** `entidad.acción`, p. ej. `booking.cancel`, `payment.refund`. */
  action: string;
  entity: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
  ip?: string | null;
}

/** Cliente transaccional o el propio Prisma: permite auditar dentro de la transacción del cambio. */
type Db = Pick<PrismaService, 'auditLog'> | Prisma.TransactionClient;

export interface AuditLogDto {
  id: string;
  actor: string | null;
  action: string;
  entity: string;
  entityId: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  createdAt: Date;
}

function toJson(
  value: unknown,
): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  if (value === undefined || value === null) return Prisma.JsonNull;
  // Normaliza fechas y otros tipos a JSON puro.
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

/**
 * Auditoría de solo inserción. Esta clase no expone update ni delete.
 * Los cambios de estado y los movimientos de dinero deben registrarse aquí,
 * preferentemente dentro de la misma transacción que el cambio (`db`).
 */
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async record(entry: AuditEntry, db: Db = this.prisma): Promise<void> {
    await db.auditLog.create({
      data: {
        actorUserId: entry.actorUserId ?? null,
        action: entry.action,
        entity: entry.entity,
        entityId: entry.entityId,
        before: toJson(entry.before),
        after: toJson(entry.after),
        ip: entry.ip ?? null,
      },
    });
  }

  async list(
    q: PaginationQuery & { entity?: string; entityId?: string },
  ): Promise<Paginated<AuditLogDto>> {
    const where: Prisma.AuditLogWhereInput = {
      ...(q.entity ? { entity: q.entity } : {}),
      ...(q.entityId ? { entityId: q.entityId } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        include: { actor: { select: { email: true } } },
        ...skipTake(q),
      }),
      this.prisma.auditLog.count({ where }),
    ]);
    return paginated(
      rows.map((r) => ({
        id: r.id,
        actor: r.actor?.email ?? null,
        action: r.action,
        entity: r.entity,
        entityId: r.entityId,
        before: (r.before as Record<string, unknown> | null) ?? null,
        after: (r.after as Record<string, unknown> | null) ?? null,
        createdAt: r.createdAt,
      })),
      q,
      total,
    );
  }
}
