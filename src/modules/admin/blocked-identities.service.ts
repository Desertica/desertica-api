import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { normalizeIp } from '../../common/net';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CreateBlockedIdentityDto } from './dto/admin.dto';

const toDto = (b: {
  id: string;
  kind: 'EMAIL' | 'IP';
  value: string;
  reason: string | null;
  createdAt: Date;
}) => ({
  id: b.id,
  kind: b.kind,
  value: b.value,
  reason: b.reason,
  createdAt: b.createdAt,
});

const isEmail = (value: string) =>
  value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

/** Correos e IP bloqueados. Se consultan al reservar, bloquear cupo y enviar reclamos. */
@Injectable()
export class BlockedIdentitiesService {
  private readonly logger = new Logger(BlockedIdentitiesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list() {
    const rows = await this.prisma.blockedIdentity.findMany({
      orderBy: { createdAt: 'desc' },
    });
    return { data: rows.map(toDto) };
  }

  async create(dto: CreateBlockedIdentityDto, actorId: string, ip?: string) {
    const value =
      dto.kind === 'EMAIL'
        ? dto.value.trim().toLowerCase()
        : normalizeIp(dto.value);
    if (!value || (dto.kind === 'EMAIL' && !isEmail(value))) {
      throw new UnprocessableEntityException(
        `value is not a valid ${dto.kind === 'EMAIL' ? 'email' : 'IP address'}`,
      );
    }
    const existing = await this.prisma.blockedIdentity.findUnique({
      where: { kind_value: { kind: dto.kind, value } },
    });
    if (existing) throw new ConflictException('Already blocked');
    const row = await this.prisma.$transaction(async (tx) => {
      const created = await tx.blockedIdentity.create({
        data: { kind: dto.kind, value, reason: dto.reason?.trim() || null },
      });
      await this.audit.record(
        {
          actorUserId: actorId,
          action: 'blockedIdentity.create',
          entity: 'BlockedIdentity',
          entityId: created.id,
          // El valor (correo o IP) es dato personal: la auditoría es inmutable y solo guarda el tipo.
          after: { kind: dto.kind },
          ip,
        },
        tx,
      );
      return created;
    });
    return toDto(row);
  }

  async remove(id: string, actorId: string, ip?: string) {
    await this.prisma.$transaction(async (tx) => {
      const row = await tx.blockedIdentity.findUnique({ where: { id } });
      if (!row) throw new NotFoundException('Blocked identity not found');
      await tx.blockedIdentity.delete({ where: { id } });
      await this.audit.record(
        {
          actorUserId: actorId,
          action: 'blockedIdentity.delete',
          entity: 'BlockedIdentity',
          entityId: id,
          before: { kind: row.kind },
          ip,
        },
        tx,
      );
    });
  }

  /**
   * Rechaza (403, sin decir el motivo) si el correo o la IP están bloqueados.
   * Una IP que no se puede leer no bloquea nada.
   */
  async assertAllowed(who: { email?: string | null; ip?: string | null }) {
    const email = who.email?.trim().toLowerCase();
    const ip = normalizeIp(who.ip);
    const or = [
      ...(email ? [{ kind: 'EMAIL' as const, value: email }] : []),
      ...(ip ? [{ kind: 'IP' as const, value: ip }] : []),
    ];
    if (or.length === 0) return;
    const hit = await this.prisma.blockedIdentity.findFirst({
      where: { OR: or },
      select: { id: true },
    });
    if (hit) {
      this.logger.warn(`Blocked request (rule ${hit.id})`);
      throw new ForbiddenException('This request cannot be processed');
    }
  }
}
