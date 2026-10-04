import {
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { paginated, skipTake } from '../../common/pagination/pagination';
import { stringToDbDate } from '../../common/time/lima';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { toPriceRuleDto } from './catalog.mappers';
import { PriceRuleInputDto, PriceRuleQuery } from './dto/catalog.dto';

@Injectable()
export class PricesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(q: PriceRuleQuery) {
    const where: Prisma.PriceRuleWhereInput = q.tourRefId
      ? { tourRefId: q.tourRefId }
      : {};
    const [rows, total] = await Promise.all([
      this.prisma.priceRule.findMany({
        where,
        orderBy: [
          { tourRefId: 'asc' },
          { priority: 'desc' },
          { createdAt: 'desc' },
        ],
        ...skipTake(q),
      }),
      this.prisma.priceRule.count({ where }),
    ]);
    return paginated(rows.map(toPriceRuleDto), q, total);
  }

  async create(dto: PriceRuleInputDto, actorId: string, ip?: string) {
    const data = await this.validate(dto);
    const row = await this.prisma.$transaction(async (tx) => {
      const created = await tx.priceRule.create({ data });
      await this.audit.record(
        {
          actorUserId: actorId,
          action: 'priceRule.create',
          entity: 'PriceRule',
          entityId: created.id,
          after: toPriceRuleDto(created),
          ip,
        },
        tx,
      );
      return created;
    });
    return toPriceRuleDto(row);
  }

  async replace(
    id: string,
    dto: PriceRuleInputDto,
    actorId: string,
    ip?: string,
  ) {
    const before = await this.prisma.priceRule.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('Price rule not found');
    const data = await this.validate(dto);
    const row = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.priceRule.update({ where: { id }, data });
      await this.audit.record(
        {
          actorUserId: actorId,
          action: 'priceRule.replace',
          entity: 'PriceRule',
          entityId: id,
          before: toPriceRuleDto(before),
          after: toPriceRuleDto(updated),
          ip,
        },
        tx,
      );
      return updated;
    });
    return toPriceRuleDto(row);
  }

  async deactivate(id: string, actorId: string, ip?: string) {
    const before = await this.prisma.priceRule.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('Price rule not found');
    await this.prisma.$transaction(async (tx) => {
      await tx.priceRule.update({ where: { id }, data: { active: false } });
      await this.audit.record(
        {
          actorUserId: actorId,
          action: 'priceRule.deactivate',
          entity: 'PriceRule',
          entityId: id,
          before: { active: before.active },
          after: { active: false },
          ip,
        },
        tx,
      );
    });
  }

  /** PUT reemplaza: los campos que no se envían vuelven a su valor por defecto. */
  private async validate(
    dto: PriceRuleInputDto,
  ): Promise<Prisma.PriceRuleUncheckedCreateInput> {
    if (
      !(await this.prisma.tourRef.findUnique({ where: { id: dto.tourRefId } }))
    ) {
      throw new UnprocessableEntityException('Unknown tourRefId');
    }
    const unit = dto.unit ?? 'PER_PERSON';
    if (unit === 'PER_GROUP' && (dto.groupCents ?? null) === null) {
      throw new UnprocessableEntityException(
        'groupCents is required for PER_GROUP',
      );
    }
    if (
      dto.minPeople != null &&
      dto.maxPeople != null &&
      dto.minPeople > dto.maxPeople
    ) {
      throw new UnprocessableEntityException('minPeople must be <= maxPeople');
    }
    if (dto.validFrom && dto.validTo && dto.validFrom > dto.validTo) {
      throw new UnprocessableEntityException('validFrom must be <= validTo');
    }
    return {
      tourRefId: dto.tourRefId,
      currency: dto.currency,
      format: dto.format ?? 'SHARED',
      unit,
      adultCents: dto.adultCents,
      childCents: dto.childCents ?? null,
      groupCents: dto.groupCents ?? null,
      minPeople: dto.minPeople ?? null,
      maxPeople: dto.maxPeople ?? null,
      validFrom: dto.validFrom ? stringToDbDate(dto.validFrom) : null,
      validTo: dto.validTo ? stringToDbDate(dto.validTo) : null,
      priority: dto.priority ?? 0,
      active: dto.active ?? true,
    };
  }
}
