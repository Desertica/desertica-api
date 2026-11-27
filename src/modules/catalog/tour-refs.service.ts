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
import { Prisma, TourRef } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CmsClient, CmsTour } from '../cms/cms.client';
import { toPublicTourDto, toTourRefDto } from './catalog.mappers';
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

  /** Datos operativos de los tours activos, para la ficha de la web. */
  async publicList() {
    const rows = await this.prisma.tourRef.findMany({
      where: { active: true },
      orderBy: { slug: 'asc' },
    });
    return { data: rows.map(toPublicTourDto) };
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
      const { meetingPoint, ...rest } = dto;
      const updated = await tx.tourRef.update({
        where: { id },
        data: {
          ...rest,
          // Una columna Json se vacía con `DbNull`, no con `null`.
          ...(meetingPoint === undefined
            ? {}
            : {
                meetingPoint:
                  meetingPoint === null ? Prisma.DbNull : { ...meetingPoint },
              }),
        },
      });
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
   * Solo refresca el título: los datos y ajustes operativos son del API y no se tocan.
   * Importación única: duración, formato, idiomas, punto de encuentro, su enlace y coordenadas se
   * copian del CMS solo si aquí siguen vacíos (el CMS está dejando de tener esos campos).
   * Un tour que ya no está publicado en el CMS queda inactivo (no se borra) y uno nuevo nace
   * inactivo hasta que operaciones le ponga precios y fechas. Reactivar es manual.
   * Con `only` (webhook del CMS) se toca solo ese slug; sin actor, la auditoría queda sin usuario.
   */
  async sync(actorId: string | null, ip?: string, only?: string) {
    // Un tour publicado solo en español también cuenta: se unen los dos idiomas.
    const [en, es] = await Promise.all([
      this.cms.listTours({ fresh: true }),
      this.cms.listTours({ fresh: true, locale: 'es' }),
    ]);
    const all = [...new Map([...es, ...en].map((t) => [t.slug, t])).values()];
    const tours = only ? all.filter((t) => t.slug === only) : all;
    const meetingOf = (list: typeof en, slug: string) =>
      list.find((t) => t.slug === slug)?.meeting;
    const empty = (v: unknown) =>
      v === null || v === undefined || (Array.isArray(v) && v.length === 0);
    /** Importación única: valores del CMS para los campos que en `current` siguen vacíos. */
    const importOnce = (tour: CmsTour, current?: TourRef) => {
      const meetingEn = meetingOf(en, tour.slug);
      const meetingEs = meetingOf(es, tour.slug);
      const fromCms = {
        durationHours: tour.durationHours,
        format: tour.format,
        languages: tour.languages,
        meetingPoint:
          meetingEn || meetingEs
            ? {
                ...(meetingEn ? { en: meetingEn } : {}),
                ...(meetingEs ? { es: meetingEs } : {}),
              }
            : null,
        meetingPointUrl: tour.meetingPointUrl,
        latitude: tour.latitude,
        longitude: tour.longitude,
      };
      return Object.fromEntries(
        Object.entries(fromCms).filter(
          ([key, value]) =>
            !empty(value) && empty(current?.[key as keyof typeof fromCms]),
        ),
      ) as Partial<{
        [K in keyof typeof fromCms]: NonNullable<(typeof fromCms)[K]>;
      }>;
    };
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
              ...importOnce(tour),
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
              ...importOnce(tour, current),
              cmsSyncedAt: now,
            },
          });
          updated++;
        }
      }
      // Con el CMS vacío no se desactiva nada: es más probable una falla que "no hay tours".
      if (all.length) {
        const gone = await tx.tourRef.updateMany({
          where: {
            active: true,
            slug: only
              ? { in: tours.length ? [] : [only] }
              : { notIn: tours.map((t) => t.slug) },
          },
          data: { active: false, cmsSyncedAt: now },
        });
        deactivated = gone.count;
      }
      await this.audit.record(
        {
          actorUserId: actorId,
          action: 'tourRef.sync',
          entity: 'TourRef',
          entityId: only ?? 'all',
          after: { created, updated, deactivated },
          ip,
        },
        tx,
      );
    });
    return { created, updated, deactivated };
  }
}
