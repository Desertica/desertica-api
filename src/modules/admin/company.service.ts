import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { hasRucFormat, hasValidRucCheckDigit } from '../../common/ruc';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CompanyDto, CreateSeriesDto } from './dto/admin.dto';

const u = <T>(value: T | null | undefined): T | undefined => value ?? undefined;

type CompanyRow = Prisma.CompanyGetPayload<object>;

const toCompanyDto = (c: CompanyRow) => ({
  id: c.id,
  ruc: c.ruc,
  legalName: c.legalName,
  tradeName: u(c.tradeName),
  fiscalAddress: c.fiscalAddress,
  ubigeo: u(c.ubigeo),
  igvRate: c.igvRate.toFixed(4),
  environment: c.environment,
});

const toSeriesDto = (s: Prisma.SeriesGetPayload<object>) => ({
  id: s.id,
  docType: s.docType,
  prefix: s.prefix,
  nextNumber: s.nextNumber,
  active: s.active,
});

/** Empresa emisora (una sola) y sus series de comprobantes. */
@Injectable()
export class CompanyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private current(db: Pick<PrismaService, 'company'> = this.prisma) {
    return db.company.findFirst({
      where: { active: true },
      orderBy: { createdAt: 'asc' },
    });
  }

  async get() {
    const company = await this.current();
    if (!company) throw new NotFoundException('The company is not configured');
    return toCompanyDto(company);
  }

  async save(dto: CompanyDto, actorId: string, ip?: string) {
    const environment = dto.environment;
    if (!hasRucFormat(dto.ruc)) {
      throw new UnprocessableEntityException('ruc is not a valid RUC');
    }
    const company = await this.prisma.$transaction(async (tx) => {
      // Serializa dos guardados simultáneos de la primera configuración.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('company:current'))`;
      const existing = await this.current(tx);
      const effective = environment ?? existing?.environment ?? 'BETA';
      if (effective === 'PRODUCTION' && !hasValidRucCheckDigit(dto.ruc)) {
        throw new UnprocessableEntityException(
          'ruc has an invalid check digit (required in PRODUCTION)',
        );
      }
      const data = {
        ruc: dto.ruc,
        legalName: dto.legalName.trim(),
        tradeName: dto.tradeName?.trim() || null,
        fiscalAddress: dto.fiscalAddress.trim(),
        ubigeo: dto.ubigeo ?? null,
        ...(dto.igvRate !== undefined ? { igvRate: dto.igvRate } : {}),
        ...(environment ? { environment } : {}),
      };
      if (existing && existing.ruc !== dto.ruc) {
        const clash = await tx.company.findUnique({ where: { ruc: dto.ruc } });
        if (clash) throw new ConflictException('That RUC already exists');
      }
      const saved = existing
        ? await tx.company.update({ where: { id: existing.id }, data })
        : await tx.company.create({ data });
      await this.audit.record(
        {
          actorUserId: actorId,
          action: existing ? 'company.update' : 'company.create',
          entity: 'Company',
          entityId: saved.id,
          before: existing ? toCompanyDto(existing) : null,
          after: toCompanyDto(saved),
          ip,
        },
        tx,
      );
      return saved;
    });
    return toCompanyDto(company);
  }

  async listSeries() {
    const company = await this.current();
    if (!company) return { data: [] };
    const rows = await this.prisma.series.findMany({
      where: { companyId: company.id },
      orderBy: [{ docType: 'asc' }, { prefix: 'asc' }],
    });
    return { data: rows.map(toSeriesDto) };
  }

  async createSeries(dto: CreateSeriesDto, actorId: string, ip?: string) {
    const company = await this.current();
    if (!company) {
      throw new ConflictException('Configure the company before its series');
    }
    const created = await this.prisma.$transaction(async (tx) => {
      const clash = await tx.series.findUnique({
        where: {
          companyId_prefix: { companyId: company.id, prefix: dto.prefix },
        },
      });
      if (clash) throw new ConflictException('That series already exists');
      const series = await tx.series.create({
        data: {
          companyId: company.id,
          docType: dto.docType,
          prefix: dto.prefix,
          nextNumber: dto.nextNumber ?? 1,
        },
      });
      await this.audit.record(
        {
          actorUserId: actorId,
          action: 'series.create',
          entity: 'Series',
          entityId: series.id,
          after: toSeriesDto(series),
          ip,
        },
        tx,
      );
      return series;
    });
    return toSeriesDto(created);
  }
}
