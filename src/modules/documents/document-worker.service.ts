import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EnvVars } from '../../config/env.validation';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import {
  BILLING_CLIENT,
  BillingError,
  type BillingClient,
  type EmitResult,
} from '../billing/billing-client';
import {
  DOCUMENT_STORAGE,
  type DocumentStorage,
} from '../billing/document-storage';
import { JobPayload, asJson } from './document-ops';
import {
  DocumentsService,
  FILE_TYPES,
  type FileKind,
} from './documents.service';

const ADVISORY_KEY = 'desertica:document-worker';
const MAX_ATTEMPTS = 10;
const LEASE_MS = 5 * 60_000;
/** Un comprobante que SUNAT no resuelve en este tiempo requiere al staff. */
const MAX_AGE_MS = 72 * 3_600_000;
const FILES: FileKind[] = ['xml', 'cdr', 'pdf'];
const KEY_FIELD = { xml: 'xmlKey', cdr: 'cdrKey', pdf: 'pdfKey' } as const;

type Job = Prisma.DocumentJobGetPayload<object>;

/** Espera entre reintentos: 30 s, 1 min, 2 min… hasta 1 hora. */
export const backoffMs = (attempts: number) =>
  Math.min(30_000 * 2 ** Math.max(0, attempts - 1), 3_600_000);

/**
 * Despacha la cola de comprobantes hacia `desertica-billing`: cada trabajo
 * manda la misma petición (misma `externalId`) en cada reintento, guarda los
 * archivos detrás de `DocumentStorage` y sigue el estado hasta que SUNAT
 * resuelve. También emite los comprobantes de pagos confirmados que todavía no
 * tienen (pagos manuales, o si el aviso inmediato falló). Un candado de
 * Postgres evita que dos instancias trabajen a la vez.
 */
@Injectable()
export class DocumentWorker
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(DocumentWorker.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly documents: DocumentsService,
    @Inject(BILLING_CLIENT) private readonly billing: BillingClient,
    @Inject(DOCUMENT_STORAGE) private readonly storage: DocumentStorage,
    private readonly config: ConfigService<EnvVars, true>,
  ) {}

  onApplicationBootstrap(): void {
    const seconds = this.config.get('DOCUMENT_WORKER_SECONDS', { infer: true });
    if (seconds <= 0 || this.config.get('NODE_ENV', { infer: true }) === 'test')
      return;
    this.timer = setInterval(() => {
      this.runOnce().catch((error: unknown) =>
        this.logger.error(
          `Document worker failed: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    }, seconds * 1000);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async runOnce(now = new Date()): Promise<{ issued: number; jobs: number }> {
    return this.prisma.$transaction(
      async (tx) => {
        const row = await tx.$queryRaw<{ locked: boolean }[]>`
          SELECT pg_try_advisory_xact_lock(hashtext(${ADVISORY_KEY})) AS locked`;
        if (!row[0]?.locked) return { issued: 0, jobs: 0 };
        const issued = await this.issueMissing(now);
        const jobs = await this.runJobs(now);
        return { issued, jobs };
      },
      { timeout: 600_000, maxWait: 5_000 },
    );
  }

  /** Pagos confirmados sin comprobante (últimos 30 días). */
  private async issueMissing(now: Date): Promise<number> {
    if (!(await this.documents.autoIssueEnabled())) return 0;
    const payments = await this.prisma.payment.findMany({
      where: {
        status: { in: ['SUCCEEDED', 'PARTIALLY_REFUNDED'] },
        paidAt: {
          lte: new Date(now.getTime() - 5_000),
          gte: new Date(now.getTime() - 30 * 86_400_000),
        },
        documents: { none: {} },
        refunds: { none: { status: 'PENDING' } },
      },
      orderBy: { paidAt: 'asc' },
      select: { id: true },
      take: 20,
    });
    let issued = 0;
    for (const { id } of payments) {
      if (await this.documents.autoIssueForPayment(id)) issued++;
    }
    return issued;
  }

  private async runJobs(now: Date): Promise<number> {
    let processed = 0;
    // Por lotes hasta vaciar lo vencido (con tope). Un trabajo ya visto en esta
    // pasada no se repite aunque su reintento también venza dentro de `now`.
    const seen: string[] = [];
    for (let batch = 0; batch < 20; batch++) {
      const due = await this.prisma.documentJob.findMany({
        where: {
          status: 'PENDING',
          nextAttemptAt: { lte: now },
          id: { notIn: seen },
        },
        orderBy: { nextAttemptAt: 'asc' },
        take: 50,
      });
      if (due.length === 0) break;
      for (const job of due) {
        seen.push(job.id);
        // Arrendamiento: nadie más toma el trabajo mientras se procesa.
        const claimed = await this.prisma.documentJob.updateMany({
          where: { id: job.id, status: 'PENDING', nextAttemptAt: { lte: now } },
          data: { nextAttemptAt: new Date(now.getTime() + LEASE_MS) },
        });
        if (claimed.count === 0) continue;
        processed++;
        try {
          if (job.kind === 'SYNC') await this.processSync(job);
          else await this.processVoid(job);
        } catch (error) {
          await this.fail(job, error);
        }
      }
    }
    return processed;
  }

  // ------------------------------------------------------------ Emisión

  private async processSync(job: Job): Promise<void> {
    const doc = await this.prisma.document.findUniqueOrThrow({
      where: { id: job.documentId },
      include: { relatedDocument: true },
    });
    const emit = (job.payload as JobPayload | null)?.emit;
    if (!emit)
      throw new BillingError('Job without request', 'INTERNAL_ERROR', 0, false);

    if (doc.docType === 'NOTA_CREDITO' && doc.status === 'PENDING') {
      const rel = doc.relatedDocument;
      if (!rel || ['REJECTED', 'ERROR', 'VOIDED'].includes(rel.status)) {
        await this.setStatus(doc.id, doc.status, 'ERROR', {
          sunatMessage: 'The affected document was not accepted',
        });
        await this.finish(job, 'DONE');
        await this.documents.alertOnce('document_failed', {
          documentId: doc.id,
        });
        return;
      }
      if (rel.status !== 'ACCEPTED' && rel.status !== 'ISSUED') {
        // El comprobante original todavía se está emitiendo: la nota espera.
        await this.reschedule(job, 60_000);
        return;
      }
    }

    const result: EmitResult | null =
      doc.status === 'PENDING'
        ? await this.billing.emit(emit)
        : await this.billing.getStatus(doc.id);
    if (!result)
      throw new BillingError('Unknown to billing', 'NOT_FOUND', 404, true);

    await this.applyResult(doc, result);
    const fresh = await this.prisma.document.findUniqueOrThrow({
      where: { id: doc.id },
    });
    let missing = false;
    if (fresh.status === 'ACCEPTED' || fresh.status === 'ISSUED') {
      missing = await this.storeFiles(fresh, result);
    }

    switch (fresh.status) {
      case 'ACCEPTED':
        if (missing)
          throw new BillingError(
            'A file is not ready',
            'FILE_PENDING',
            0,
            true,
          );
        await this.finish(job, 'DONE');
        return;
      case 'ISSUED':
      case 'PENDING':
        if (Date.now() - doc.createdAt.getTime() > MAX_AGE_MS) {
          await this.finish(
            job,
            'DEAD',
            'SUNAT did not resolve the document in time',
          );
          await this.documents.alertOnce('document_failed', {
            documentId: doc.id,
          });
          return;
        }
        await this.reschedule(
          job,
          fresh.status === 'ISSUED' ? 3_600_000 : 60_000,
        );
        return;
      case 'REJECTED':
      case 'ERROR':
        await this.finish(job, 'DONE');
        await this.documents.alertOnce('document_rejected', {
          documentId: doc.id,
          sunatCode: fresh.sunatCode,
          sunatMessage: fresh.sunatMessage,
        });
        return;
      default:
        await this.finish(job, 'DONE');
    }
  }

  private async applyResult(
    doc: Prisma.DocumentGetPayload<object>,
    result: EmitResult,
  ): Promise<void> {
    const ours = doc.totalCents;
    const hasAmounts =
      result.taxableCents !== undefined &&
      result.igvCents !== undefined &&
      result.taxableCents + result.igvCents === ours;
    if (
      result.taxableCents !== undefined &&
      (!hasAmounts ||
        result.taxableCents !== doc.taxableCents ||
        result.igvCents !== doc.igvCents)
    ) {
      this.logger.warn(
        `Document ${doc.id}: billing computed ${result.taxableCents}+${result.igvCents}, API ${doc.taxableCents}+${doc.igvCents}`,
      );
    }
    const issued = result.status === 'ISSUED' || result.status === 'ACCEPTED';
    await this.prisma.document.update({
      where: { id: doc.id },
      data: {
        status: result.status,
        sunatCode: result.sunatCode ?? null,
        sunatMessage: result.sunatMessage ?? null,
        ...(hasAmounts
          ? { taxableCents: result.taxableCents, igvCents: result.igvCents }
          : {}),
        ...(issued && !doc.issuedAt ? { issuedAt: new Date() } : {}),
        ...(result.status === 'VOIDED' && !doc.voidedAt
          ? { voidedAt: new Date() }
          : {}),
      },
    });
    if (result.status !== doc.status) {
      await this.audit.record({
        action: 'document.status',
        entity: 'Document',
        entityId: doc.id,
        before: { status: doc.status },
        after: { status: result.status, sunatCode: result.sunatCode ?? null },
      });
    }
  }

  /** Baja los archivos de billing y los guarda. `true` si falta alguno que billing dice tener. */
  private async storeFiles(
    doc: Prisma.DocumentGetPayload<object>,
    result: EmitResult,
  ): Promise<boolean> {
    let missing = false;
    const year = (doc.issuedAt ?? doc.createdAt).getUTCFullYear();
    for (const kind of FILES) {
      if (doc[KEY_FIELD[kind]]) continue;
      const flagged = result.files?.[kind];
      if (flagged === false) continue;
      if (flagged === undefined && doc.status !== 'ACCEPTED') continue;
      const file = await this.billing.downloadFile(doc.id, kind);
      if (!file) {
        if (flagged === true) missing = true;
        continue;
      }
      const key = `documents/${year}/${doc.id}.${FILE_TYPES[kind].ext}`;
      await this.storage.put(key, file.data);
      await this.prisma.document.update({
        where: { id: doc.id },
        data: { [KEY_FIELD[kind]]: key },
      });
    }
    return missing;
  }

  // -------------------------------------------------------------- Baja

  private async processVoid(job: Job): Promise<void> {
    const doc = await this.prisma.document.findUniqueOrThrow({
      where: { id: job.documentId },
    });
    const payload = (job.payload as JobPayload | null) ?? {};
    const v = payload.void;
    if (!v)
      throw new BillingError('Job without request', 'INTERNAL_ERROR', 0, false);

    if (!v.ticket) {
      const started = await this.billing.void(doc.id, {
        reason: v.reason,
        voidDate: v.voidDate,
      });
      v.ticket = started.ticket;
      await this.prisma.documentJob.update({
        where: { id: job.id },
        data: { payload: asJson({ ...payload, void: v }) },
      });
    }
    const ticket = await this.billing.getTicket(v.ticket);
    if (!ticket)
      throw new BillingError('Unknown ticket', 'NOT_FOUND', 404, true);
    if (ticket.status === 'PENDING') {
      if (Date.now() - job.createdAt.getTime() > MAX_AGE_MS) {
        await this.finish(
          job,
          'DEAD',
          'SUNAT did not resolve the void in time',
        );
        await this.documents.alertOnce('document_void_failed', {
          documentId: doc.id,
        });
        return;
      }
      await this.reschedule(job, 60_000);
      return;
    }
    if (ticket.status === 'ACCEPTED') {
      await this.prisma.document.update({
        where: { id: doc.id },
        data: {
          status: 'VOIDED',
          voidedAt: new Date(),
          sunatCode: ticket.sunatCode ?? doc.sunatCode,
          sunatMessage: ticket.sunatMessage ?? doc.sunatMessage,
        },
      });
      await this.audit.record({
        action: 'document.void',
        entity: 'Document',
        entityId: doc.id,
        before: { status: doc.status },
        after: { status: 'VOIDED', ticket: v.ticket },
      });
      await this.finish(job, 'DONE');
      return;
    }
    // REJECTED o ERROR: el comprobante sigue vigente.
    await this.prisma.document.update({
      where: { id: doc.id },
      data: { sunatMessage: ticket.sunatMessage ?? doc.sunatMessage },
    });
    await this.finish(job, 'DONE', `Void ${ticket.status}`);
    await this.documents.alertOnce('document_void_rejected', {
      documentId: doc.id,
      sunatMessage: ticket.sunatMessage ?? null,
    });
  }

  // ------------------------------------------------------ Estado del trabajo

  private async setStatus(
    id: string,
    from: string,
    to: 'ERROR',
    extra: { sunatMessage?: string; sunatCode?: string | null } = {},
  ): Promise<void> {
    await this.prisma.document.update({
      where: { id },
      data: { status: to, ...extra },
    });
    await this.audit.record({
      action: 'document.status',
      entity: 'Document',
      entityId: id,
      before: { status: from },
      after: { status: to },
    });
  }

  private async finish(job: Job, status: 'DONE' | 'DEAD', error?: string) {
    await this.prisma.documentJob.update({
      where: { id: job.id },
      data: { status, lastError: error ?? null },
    });
  }

  /** Vuelve a programar sin contar un intento fallido (espera a SUNAT). */
  private async reschedule(job: Job, delayMs: number) {
    await this.prisma.documentJob.update({
      where: { id: job.id },
      data: { nextAttemptAt: new Date(Date.now() + delayMs), lastError: null },
    });
  }

  /** Error al procesar: reintento con espera creciente, o fin si no se puede reintentar. */
  private async fail(job: Job, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    const retryable = error instanceof BillingError ? error.retryable : true;
    const attempts = job.attempts + 1;
    this.logger.warn(
      `Document job ${job.id} (${job.kind}) failed, attempt ${attempts}: ${message}`,
    );
    const doc = await this.prisma.document.findUnique({
      where: { id: job.documentId },
    });
    if (retryable && attempts < MAX_ATTEMPTS) {
      await this.prisma.documentJob.update({
        where: { id: job.id },
        data: {
          attempts,
          lastError: message.slice(0, 500),
          nextAttemptAt: new Date(Date.now() + backoffMs(attempts)),
        },
      });
      return;
    }
    await this.prisma.documentJob.update({
      where: { id: job.id },
      data: {
        attempts,
        status: retryable ? 'DEAD' : 'DONE',
        lastError: message.slice(0, 500),
      },
    });
    if (doc && job.kind === 'SYNC' && doc.status === 'PENDING') {
      await this.setStatus(doc.id, doc.status, 'ERROR', {
        sunatMessage: message.slice(0, 250),
        sunatCode:
          error instanceof BillingError ? (error.sunatCode ?? null) : null,
      });
    }
    await this.documents.alertOnce('document_failed', {
      documentId: job.documentId,
      kind: job.kind,
      error: message.slice(0, 200),
    });
  }
}
