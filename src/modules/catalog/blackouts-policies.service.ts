import {
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { stringToDbDate } from '../../common/time/lima';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { toBlackoutDto, toPolicyDto } from './catalog.mappers';
import {
  BlackoutInputDto,
  CancellationPolicyInputDto,
} from './dto/catalog.dto';

@Injectable()
export class BlackoutsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list() {
    const rows = await this.prisma.blackout.findMany({
      orderBy: { startsOn: 'asc' },
    });
    return { data: rows.map(toBlackoutDto) };
  }

  async create(dto: BlackoutInputDto, actorId: string, ip?: string) {
    if (dto.startsOn > dto.endsOn) {
      throw new UnprocessableEntityException('startsOn must be <= endsOn');
    }
    if (
      dto.tourRefId &&
      !(await this.prisma.tourRef.findUnique({ where: { id: dto.tourRefId } }))
    ) {
      throw new UnprocessableEntityException('Unknown tourRefId');
    }
    const row = await this.prisma.$transaction(async (tx) => {
      const created = await tx.blackout.create({
        data: {
          tourRefId: dto.tourRefId ?? null,
          startsOn: stringToDbDate(dto.startsOn),
          endsOn: stringToDbDate(dto.endsOn),
          reason: dto.reason,
        },
      });
      await this.audit.record(
        {
          actorUserId: actorId,
          action: 'blackout.create',
          entity: 'Blackout',
          entityId: created.id,
          after: toBlackoutDto(created),
          ip,
        },
        tx,
      );
      return created;
    });
    return toBlackoutDto(row);
  }

  async delete(id: string, actorId: string, ip?: string) {
    const before = await this.prisma.blackout.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('Blackout not found');
    await this.prisma.$transaction(async (tx) => {
      await tx.blackout.delete({ where: { id } });
      await this.audit.record(
        {
          actorUserId: actorId,
          action: 'blackout.delete',
          entity: 'Blackout',
          entityId: id,
          before: toBlackoutDto(before),
          ip,
        },
        tx,
      );
    });
  }
}

@Injectable()
export class PoliciesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list() {
    const rows = await this.prisma.cancellationPolicy.findMany({
      orderBy: [{ key: 'asc' }, { version: 'desc' }],
    });
    return { data: rows.map(toPolicyDto) };
  }

  /**
   * Crea la siguiente versión de `key`. Las versiones anteriores quedan
   * inactivas y los tours que las usaban pasan a la nueva. Las reservas ya
   * hechas conservan su `cancellationSnapshot`.
   */
  async create(dto: CancellationPolicyInputDto, actorId: string, ip?: string) {
    const tiers = dto.tiers
      .map((t) => ({
        hoursBefore: t.hoursBefore,
        refundPercent: t.refundPercent,
      }))
      .sort((a, b) => b.hoursBefore - a.hoursBefore);
    for (let i = 0; i < tiers.length; i++) {
      if (i > 0 && tiers[i].hoursBefore === tiers[i - 1].hoursBefore) {
        throw new UnprocessableEntityException(
          'Duplicate hoursBefore in tiers',
        );
      }
      if (i > 0 && tiers[i].refundPercent > tiers[i - 1].refundPercent) {
        throw new UnprocessableEntityException(
          'Refund percent cannot increase as the departure gets closer',
        );
      }
    }

    const row = await this.prisma.$transaction(async (tx) => {
      const previous = await tx.cancellationPolicy.findMany({
        where: { key: dto.key },
      });
      const version =
        previous.reduce((max, p) => Math.max(max, p.version), 0) + 1;
      const created = await tx.cancellationPolicy.create({
        data: {
          key: dto.key,
          name: dto.name,
          version,
          tiers,
          depositRefundable: dto.depositRefundable ?? false,
        },
      });
      if (previous.length > 0) {
        const oldIds = previous.map((p) => p.id);
        await tx.cancellationPolicy.updateMany({
          where: { id: { in: oldIds } },
          data: { active: false },
        });
        await tx.tourRef.updateMany({
          where: { cancellationPolicyId: { in: oldIds } },
          data: { cancellationPolicyId: created.id },
        });
      }
      await this.audit.record(
        {
          actorUserId: actorId,
          action: 'cancellationPolicy.create',
          entity: 'CancellationPolicy',
          entityId: created.id,
          after: toPolicyDto(created),
          ip,
        },
        tx,
      );
      return created;
    });
    return toPolicyDto(row);
  }
}
