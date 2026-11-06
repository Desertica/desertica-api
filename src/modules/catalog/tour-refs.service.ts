import {
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  paginated,
  PaginationQuery,
  skipTake,
} from '../../common/pagination/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CmsClient } from '../cms/cms.client';
import { toTourRefDto } from './catalog.mappers';
import { UpdateTourRefDto } from './dto/catalog.dto';

@Injectable()
export class TourRefsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cms: CmsClient,
    private readonly audit: AuditService,
  ) {}

  async list(q: PaginationQuery) {
    const [rows, total] = await Promise.all([
      this.prisma.tourRef.findMany({
        orderBy: { slug: 'asc' },
        ...skipTake(q),
      }),
      this.prisma.tourRef.count(),
    ]);
    return paginated(rows.map(toTourRefDto), q, total);
  }

  async get(id: string) {
    const row = await this.prisma.tourRef.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Tour not found');
    return toTourRefDto(row);
  }

  async update(
    id: string,
    dto: UpdateTourRefDto,
    actorId: string,
    ip?: string,
  ) {
    const before = await this.prisma.tourRef.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('Tour not found');
    if (dto.cancellationPolicyId) {
      const policy = await this.prisma.cancellationPolicy.findUnique({
        where: { id: dto.cancellationPolicyId },
      });
      if (!policy?.active) {
        throw new UnprocessableEntityException('Unknown or inactive policy');
      }
    }
    const row = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.tourRef.update({ where: { id }, data: dto });
      await this.audit.record(
        {
          actorUserId: actorId,
          action: 'tourRef.update',
          entity: 'TourRef',
          entityId: id,
          before: toTourRefDto(before),
          after: toTourRefDto(updated),
          ip,
        },
        tx,
      );
      return updated;
    });
    return toTourRefDto(row);
  }

  /**
   * Trae los tours del CMS (sin caché) y crea/actualiza `TourRef` por slug.
   * Solo refresca título y duración: los ajustes operativos no se tocan.
   * Un tour que ya no está publicado en el CMS queda inactivo (no se borra) y uno nuevo nace
   * inactivo hasta que operaciones le ponga precios y fechas. Reactivar es manual.
   */
  async sync(actorId: string, ip?: string) {
    // Un tour publicado solo en español también cuenta: se unen los dos idiomas.
    const [en, es] = await Promise.all([
      this.cms.listTours({ fresh: true }),
      this.cms.listTours({ fresh: true, locale: 'es' }),
    ]);
    const tours = [...new Map([...es, ...en].map((t) => [t.slug, t])).values()];
    const existing = new Map(
      (
        await this.prisma.tourRef.findMany({
          where: { slug: { in: tours.map((t) => t.slug) } },
        })
      ).map((t) => [t.slug, t]),
    );
    const now = new Date();
    let created = 0;
    let updated = 0;
    let deactivated = 0;
    await this.prisma.$transaction(async (tx) => {
      for (const tour of tours) {
        const current = existing.get(tour.slug);
        if (!current) {
          await tx.tourRef.create({
            data: {
              slug: tour.slug,
              title: tour.title,
              durationHours: tour.durationHours,
              active: false,
              cmsSyncedAt: now,
            },
          });
          created++;
        } else {
          await tx.tourRef.update({
            where: { id: current.id },
            data: {
              title: tour.title,
              durationHours: tour.durationHours,
              cmsSyncedAt: now,
            },
          });
          updated++;
        }
      }
      // shortcut: sin webhook, esto corre solo al sincronizar; automatizarlo si se despublica a menudo.
      // Con el CMS vacío no se desactiva nada: es más probable una falla que "no hay tours".
      if (tours.length) {
        const gone = await tx.tourRef.updateMany({
          where: { active: true, slug: { notIn: tours.map((t) => t.slug) } },
          data: { active: false, cmsSyncedAt: now },
        });
        deactivated = gone.count;
      }
      await this.audit.record(
        {
          actorUserId: actorId,
          action: 'tourRef.sync',
          entity: 'TourRef',
          entityId: 'all',
          after: { created, updated, deactivated },
          ip,
        },
        tx,
      );
    });
    return { created, updated, deactivated };
  }
}
