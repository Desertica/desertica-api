import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Prisma } from '../../generated/prisma/client';
import { LegalDocumentKind } from '../../generated/prisma/enums';
import { paginated, skipTake } from '../../common/pagination/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CmsClient } from '../cms/cms.client';
import { LegalDocumentQuery } from './dto/compliance.dto';

/** Documentos que el cliente debe aceptar para reservar. */
export const REQUIRED_KINDS: LegalDocumentKind[] = [
  'TERMS',
  'PRIVACY',
  'CANCELLATION',
];

type Db = PrismaService | Prisma.TransactionClient;

export const toLegalDto = (d: {
  id: string;
  kind: LegalDocumentKind;
  locale: string;
  version: number;
  cmsSlug: string;
  tourRefId?: string | null;
  title: string;
  publishedAt: Date;
  contentHash: string;
}) => ({
  id: d.id,
  kind: d.kind,
  locale: d.locale,
  version: d.version,
  cmsSlug: d.cmsSlug,
  tourRefId: d.tourRefId ?? null,
  title: d.title,
  publishedAt: d.publishedAt,
  contentHash: d.contentHash,
});

export function hashLegalText(title: string, text: string): string {
  return createHash('sha256').update(`${title}\n\n${text}`).digest('hex');
}

@Injectable()
export class LegalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cms: CmsClient,
    private readonly audit: AuditService,
  ) {}

  /**
   * Publica una versión nueva: trae el texto del CMS y guarda un snapshot
   * inmutable (título, texto y hash). La versión siguiente se calcula con un
   * candado para que dos publicaciones simultáneas no choquen.
   *
   * - Documentos globales: la página `cmsSlug` del CMS; versión por `(kind, locale)`.
   * - `WAIVER`: el campo `waiverBody` del tour `tourRefId` en ese idioma;
   *   versión por `(tour, locale)`.
   */
  async publish(
    dto: {
      kind: LegalDocumentKind;
      locale: string;
      cmsSlug?: string;
      tourRefId?: string;
    },
    actorId: string,
    ip?: string,
  ) {
    const snapshot =
      dto.kind === 'WAIVER'
        ? await this.waiverSnapshot(dto)
        : await this.pageSnapshot(dto);
    const scopeKey = snapshot.tourRefId ?? '';
    const row = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`legal:${dto.kind}:${dto.locale}:${scopeKey}`}))`;
      const last = await tx.legalDocument.findFirst({
        where: { kind: dto.kind, locale: dto.locale, scopeKey },
        orderBy: { version: 'desc' },
      });
      const created = await tx.legalDocument.create({
        data: {
          kind: dto.kind,
          locale: dto.locale,
          version: (last?.version ?? 0) + 1,
          tourRefId: snapshot.tourRefId,
          scopeKey,
          cmsSlug: snapshot.cmsSlug,
          title: snapshot.title,
          textSnapshot: snapshot.body,
          contentHash: hashLegalText(snapshot.title, snapshot.body),
          publishedAt: new Date(),
        },
      });
      await this.audit.record(
        {
          actorUserId: actorId,
          action: 'legalDocument.publish',
          entity: 'LegalDocument',
          entityId: created.id,
          after: toLegalDto(created),
          ip,
        },
        tx,
      );
      return created;
    });
    return toLegalDto(row);
  }

  private async pageSnapshot(dto: {
    kind: LegalDocumentKind;
    locale: string;
    cmsSlug?: string;
    tourRefId?: string;
  }) {
    if (!dto.cmsSlug) {
      throw new UnprocessableEntityException('cmsSlug is required');
    }
    if (dto.tourRefId) {
      throw new UnprocessableEntityException(
        'tourRefId only applies to WAIVER documents',
      );
    }
    const page = await this.cms.getPage(dto.cmsSlug, dto.locale);
    if (!page || !page.body.trim()) {
      throw new UnprocessableEntityException(
        `The CMS has no "${dto.cmsSlug}" page in "${dto.locale}"`,
      );
    }
    return {
      tourRefId: null,
      cmsSlug: dto.cmsSlug,
      title: page.title,
      body: page.body,
    };
  }

  private async waiverSnapshot(dto: {
    locale: string;
    cmsSlug?: string;
    tourRefId?: string;
  }) {
    if (!dto.tourRefId) {
      throw new UnprocessableEntityException(
        'tourRefId is required for a WAIVER',
      );
    }
    if (dto.cmsSlug) {
      throw new UnprocessableEntityException(
        'cmsSlug does not apply to a WAIVER: the tour slug is used',
      );
    }
    const tour = await this.prisma.tourRef.findUnique({
      where: { id: dto.tourRefId },
      select: { id: true, slug: true },
    });
    if (!tour) throw new UnprocessableEntityException('Unknown tourRefId');
    const cmsTour = await this.cms.getTourWaiver(tour.slug, dto.locale);
    if (!cmsTour) {
      throw new UnprocessableEntityException(
        `The CMS has no tour "${tour.slug}" in "${dto.locale}"`,
      );
    }
    if (!cmsTour.waiverBody) {
      throw new UnprocessableEntityException(
        `The CMS tour "${tour.slug}" has no waiver text (waiverBody) in "${dto.locale}"`,
      );
    }
    return {
      tourRefId: tour.id,
      cmsSlug: tour.slug,
      title: cmsTour.title,
      body: cmsTour.waiverBody,
    };
  }

  async list(q: LegalDocumentQuery) {
    const where = {
      ...(q.kind ? { kind: q.kind } : {}),
      ...(q.locale ? { locale: q.locale } : {}),
      ...(q.tourRefId ? { tourRefId: q.tourRefId } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.legalDocument.findMany({
        where,
        orderBy: [{ publishedAt: 'desc' }, { version: 'desc' }],
        ...skipTake(q),
      }),
      this.prisma.legalDocument.count({ where }),
    ]);
    return paginated(rows.map(toLegalDto), q, total);
  }

  /**
   * Versión del descargo con la que se firma una reserva de `tourRefId` en
   * `locale`: la última de ese idioma o, si no hay, la última en inglés (el
   * idioma por defecto del CMS). Sin ninguna, la reserva no puede crearse: un
   * pasajero no puede firmar un texto que no está guardado.
   */
  async waiverFor(db: Db, tourRefId: string, locale: string) {
    for (const candidate of locale === 'en' ? ['en'] : [locale, 'en']) {
      const doc = await db.legalDocument.findFirst({
        where: { kind: 'WAIVER', locale: candidate, tourRefId },
        orderBy: { version: 'desc' },
      });
      if (doc) return doc;
    }
    throw new ConflictException(
      'The waiver text for this tour is not published yet',
    );
  }

  /** Última versión de cada tipo en el idioma pedido. */
  async current(locale: string) {
    const rows = await this.prisma.legalDocument.findMany({
      // Los descargos son por tour: no se aceptan al reservar, se firman después.
      where: { locale, kind: { not: 'WAIVER' } },
      orderBy: [{ kind: 'asc' }, { version: 'desc' }],
    });
    const seen = new Set<string>();
    const latest = rows.filter((r) => !seen.has(r.kind) && seen.add(r.kind));
    return { data: latest.map(toLegalDto) };
  }

  /**
   * Verifica lo que el cliente dice haber aceptado: ids existentes, de la
   * versión vigente en ese idioma, y que cubran todos los tipos obligatorios.
   */
  async assertAcceptable(ids: string[], locale: string, db: Db = this.prisma) {
    const unique = [...new Set(ids)];
    const docs = await db.legalDocument.findMany({
      where: { id: { in: unique } },
    });
    if (docs.length !== unique.length) {
      throw new UnprocessableEntityException('Unknown legal document');
    }
    for (const doc of docs) {
      if (doc.kind === 'WAIVER') {
        throw new UnprocessableEntityException(
          'A waiver is signed after booking, not accepted when booking',
        );
      }
      const latest = await db.legalDocument.findFirst({
        where: { kind: doc.kind, locale: doc.locale },
        orderBy: { version: 'desc' },
      });
      if (doc.locale !== locale || latest?.id !== doc.id) {
        throw new UnprocessableEntityException({
          message: 'A legal document is outdated or in another language',
          details: { legalDocumentId: doc.id, kind: doc.kind },
        });
      }
    }
    const kinds = new Set(docs.map((d) => d.kind));
    const missing = REQUIRED_KINDS.filter((k) => !kinds.has(k));
    if (missing.length > 0) {
      throw new UnprocessableEntityException({
        message: 'Required legal documents were not accepted',
        details: { missing },
      });
    }
    return docs;
  }

  async getSnapshot(id: string) {
    const doc = await this.prisma.legalDocument.findUnique({ where: { id } });
    if (!doc) throw new NotFoundException('Legal document not found');
    return doc;
  }
}
