import {
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Prisma } from '../../generated/prisma/client';
import { LegalDocumentKind } from '../../generated/prisma/enums';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CmsClient } from '../cms/cms.client';

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
  title: string;
  publishedAt: Date;
  contentHash: string;
}) => ({
  id: d.id,
  kind: d.kind,
  locale: d.locale,
  version: d.version,
  cmsSlug: d.cmsSlug,
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
   * inmutable (título, texto y hash). La versión siguiente de `(kind, locale)`
   * se calcula con un candado para que dos publicaciones simultáneas no choquen.
   */
  async publish(
    dto: { kind: LegalDocumentKind; locale: string; cmsSlug: string },
    actorId: string,
    ip?: string,
  ) {
    const page = await this.cms.getPage(dto.cmsSlug, dto.locale);
    if (!page || !page.body.trim()) {
      throw new UnprocessableEntityException(
        `The CMS has no "${dto.cmsSlug}" page in "${dto.locale}"`,
      );
    }
    const row = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`legal:${dto.kind}:${dto.locale}`}))`;
      const last = await tx.legalDocument.findFirst({
        where: { kind: dto.kind, locale: dto.locale },
        orderBy: { version: 'desc' },
      });
      const created = await tx.legalDocument.create({
        data: {
          kind: dto.kind,
          locale: dto.locale,
          version: (last?.version ?? 0) + 1,
          cmsSlug: dto.cmsSlug,
          title: page.title,
          textSnapshot: page.body,
          contentHash: hashLegalText(page.title, page.body),
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

  /** Última versión de cada tipo en el idioma pedido. */
  async current(locale: string) {
    const rows = await this.prisma.legalDocument.findMany({
      where: { locale },
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
