import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IdempotencyService } from '../../common/idempotency/idempotency.service';
import { rateToBps, splitIgv } from '../../common/money';
import { paginated, skipTake } from '../../common/pagination/pagination';
import { limaDate } from '../../common/time/lima';
import { EnvVars } from '../../config/env.validation';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { StaffAlertsService } from '../alerts/staff-alerts.service';
import { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../auth/auth.types';
import { toDocumentDto } from '../bookings/booking.mappers';
import type { EmitRequest } from '../billing/billing-client';
import {
  DOCUMENT_STORAGE,
  type DocumentStorage,
} from '../billing/document-storage';
import { ExchangeRateService } from '../billing/exchange-rate.service';
import {
  CREDIT_NOTE_REASON,
  JobPayload,
  asJson,
  documentNumber,
} from './document-ops';
import {
  CreditNoteDto,
  DocumentsQuery,
  IssueDocumentDto,
  VoidDocumentDto,
} from './dto/documents.dto';

type Tx = Prisma.TransactionClient;
type Doc = Prisma.DocumentGetPayload<{ include: { series: true } }>;

interface BillingData {
  docType?: 'BOLETA' | 'FACTURA';
  name?: string;
  idDocType?: 'DNI' | 'CE' | 'PASSPORT' | 'RUC';
  idDocNumber?: string;
  address?: string;
  email?: string;
}

const FILE_KEY = {
  xml: 'xmlKey',
  cdr: 'cdrKey',
  pdf: 'pdfKey',
} as const;
export type FileKind = keyof typeof FILE_KEY;
export const FILE_TYPES: Record<
  FileKind,
  { contentType: string; ext: string }
> = {
  xml: { contentType: 'application/xml', ext: 'xml' },
  cdr: { contentType: 'application/zip', ext: 'zip' },
  pdf: { contentType: 'application/pdf', ext: 'pdf' },
};

const WITH_SERIES = {
  series: true,
  booking: { select: { reference: true } },
} as const;

/** Un comprobante cuenta como emitido mientras no se anule. */
const COUNTED = { status: { not: 'VOIDED' as const } };

/**
 * Comprobantes: crea el `Document` (serie y correlativo bajo bloqueo, base e
 * IGV, tipo de cambio) y deja el envío a `desertica-billing` en la cola
 * `DocumentJob`; `DocumentWorker` lo despacha con reintentos y la misma
 * `externalId`. El certificado y la clave SOL no existen aquí.
 */
@Injectable()
export class DocumentsService {
  private readonly logger = new Logger(DocumentsService.name);
  private readonly lastAlert = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
    private readonly alerts: StaffAlertsService,
    private readonly exchange: ExchangeRateService,
    @Inject(DOCUMENT_STORAGE) private readonly storage: DocumentStorage,
    private readonly config: ConfigService<EnvVars, true>,
  ) {}

  // ------------------------------------------------------------ Ajustes

  /** `Setting.autoIssueDocuments` (por defecto `true`): emitir al confirmarse un pago. */
  async autoIssueEnabled(
    db: Pick<PrismaService, 'setting'> | Tx = this.prisma,
  ) {
    const row = await db.setting.findUnique({
      where: { key: 'autoIssueDocuments' },
    });
    return typeof row?.value === 'boolean' ? row.value : true;
  }

  /** Aviso al staff, a lo más uno por código cada 10 minutos (el barrido repite). */
  async alertOnce(
    code: string,
    data: Record<string, unknown>,
    bookingId?: string,
  ) {
    const key = `${code}:${bookingId ?? ''}`;
    const last = this.lastAlert.get(key) ?? 0;
    if (Date.now() - last < 10 * 60_000) return;
    this.lastAlert.set(key, Date.now());
    await this.alerts.alert(code, data, { bookingId });
  }

  // ----------------------------------------------------------- Creación

  /**
   * Crea el comprobante y su trabajo de envío. Debe correr dentro de una
   * transacción con la reserva bloqueada. Lanza `ConflictException` si no hay
   * empresa o serie configuradas (antes de cambiar nada).
   */
  async createInTx(
    tx: Tx,
    p: {
      booking: Prisma.BookingGetPayload<{
        include: { departure: { include: { tourRef: true } } };
      }>;
      paymentId: string | null;
      paymentKind?: string;
      docType: 'BOLETA' | 'FACTURA';
      totalCents: number;
      actorUserId?: string;
      auto?: boolean;
    },
  ): Promise<Doc> {
    const company = await tx.company.findFirst({
      where: { active: true },
      orderBy: { createdAt: 'asc' },
    });
    if (!company)
      throw new ConflictException('No active company is configured');
    const series = await tx.series.findFirst({
      where: { companyId: company.id, docType: p.docType, active: true },
      orderBy: { prefix: 'asc' },
    });
    if (!series) {
      throw new ConflictException(
        `No active ${p.docType} series is configured`,
      );
    }
    const billing = p.booking.billing as BillingData;
    if (!billing?.name || !billing.idDocType || !billing.idDocNumber) {
      throw new UnprocessableEntityException('The booking has no billing data');
    }
    if (p.docType === 'FACTURA' && billing.idDocType !== 'RUC') {
      throw new UnprocessableEntityException(
        'A factura needs the receptor RUC',
      );
    }

    const number = await this.nextNumber(tx, series.id);
    const igvRate = company.igvRate.toFixed(4);
    const { taxableCents, igvCents } = splitIgv(
      p.totalCents,
      rateToBps(igvRate),
    );
    const now = new Date();
    const issueDate = limaDate(now);
    const fx =
      p.booking.currency === 'USD'
        ? await this.exchange.rateFor(issueDate)
        : null;
    const customer = {
      idDocType: billing.idDocType,
      idDocNumber: billing.idDocNumber,
      name: billing.name,
      ...(billing.address ? { address: billing.address } : {}),
      ...(billing.email ? { email: billing.email } : {}),
    };
    const doc = await tx.document.create({
      data: {
        bookingId: p.booking.id,
        paymentId: p.paymentId,
        seriesId: series.id,
        number,
        docType: p.docType,
        status: 'PENDING',
        currency: p.booking.currency,
        totalCents: p.totalCents,
        taxableCents,
        igvCents,
        exchangeRate: fx?.rate ?? null,
        customerSnapshot: customer,
      },
      include: { series: true },
    });

    const people = p.booking.adults + p.booking.children;
    const when = limaDate(p.booking.departure.startsAt);
    const prefix = p.paymentKind === 'DEPOSIT' ? 'Anticipo: ' : '';
    const emit = this.baseRequest(doc, {
      igvRate,
      issueDate,
      customer,
      items: [
        {
          description:
            `${prefix}${p.booking.departure.tourRef.title} - ${when} (${people} pax) - ${p.booking.reference}`.slice(
              0,
              250,
            ),
          quantity: 1,
          unitPriceCents: p.totalCents,
          totalCents: p.totalCents,
        },
      ],
    });
    await this.enqueue(tx, doc.id, 'SYNC', { emit });
    await this.audit.record(
      {
        actorUserId: p.actorUserId,
        action: 'document.create',
        entity: 'Document',
        entityId: doc.id,
        after: {
          bookingId: p.booking.id,
          paymentId: p.paymentId,
          docType: p.docType,
          number: documentNumber(series.prefix, number),
          currency: doc.currency,
          totalCents: p.totalCents,
          taxableCents,
          igvCents,
          exchangeRate: fx ? { rate: fx.rate, source: fx.source } : null,
          auto: p.auto ?? false,
        },
      },
      tx,
    );
    return doc;
  }

  private baseRequest(
    doc: Doc,
    p: {
      igvRate: string;
      issueDate: string;
      customer: EmitRequest['customer'];
      items: EmitRequest['items'];
    } & Partial<EmitRequest>,
  ): EmitRequest {
    const submission = this.config.get('BILLING_SUBMISSION', { infer: true });
    return {
      externalId: doc.id,
      docType: doc.docType,
      series: doc.series.prefix,
      number: doc.number,
      issueDate: p.issueDate,
      currency: doc.currency,
      ...(doc.exchangeRate
        ? { exchangeRate: doc.exchangeRate.toFixed(4) }
        : {}),
      igvRate: p.igvRate,
      customer: p.customer,
      items: p.items,
      totalCents: doc.totalCents,
      ...(submission ? { submission } : {}),
      ...(p.affectedDocument ? { affectedDocument: p.affectedDocument } : {}),
      ...(p.reasonCode ? { reasonCode: p.reasonCode, reason: p.reason } : {}),
    };
  }

  /** Correlativo atómico: sin huecos si la transacción se confirma, sin saltos si falla. */
  private async nextNumber(tx: Tx, seriesId: string): Promise<number> {
    const rows = await tx.$queryRaw<{ number: number }[]>`
      UPDATE "Series" SET "nextNumber" = "nextNumber" + 1
      WHERE "id" = ${seriesId} AND "active" = true
      RETURNING "nextNumber" - 1 AS "number"`;
    if (rows.length === 0)
      throw new ConflictException('The series is not active');
    return rows[0].number;
  }

  private async enqueue(
    tx: Tx,
    documentId: string,
    kind: 'SYNC' | 'VOID',
    payload: JobPayload,
  ): Promise<void> {
    await tx.documentJob.create({
      data: { documentId, kind, payload: asJson(payload), status: 'PENDING' },
    });
  }

  // ----------------------------------------------------------- Emisión

  /** Total cobrado (neto de devoluciones) que todavía no tiene comprobante. */
  private async undocumentedCents(
    tx: Tx,
    booking: { id: string; paidCents: number; refundedCents: number },
  ): Promise<number> {
    const docs = await tx.document.findMany({
      where: { bookingId: booking.id, ...COUNTED },
      select: { docType: true, totalCents: true },
    });
    const documented = docs.reduce(
      (n, d) =>
        n + (d.docType === 'NOTA_CREDITO' ? -d.totalCents : d.totalCents),
      0,
    );
    return booking.paidCents - booking.refundedCents - documented;
  }

  async issue(
    bookingId: string,
    dto: IssueDocumentDto,
    actor: AuthUser,
    ctx: { idempotencyKey?: string },
  ) {
    const result = await this.idempotency.run(
      {
        scope: `issueDocument:${bookingId}`,
        key: ctx.idempotencyKey,
        request: dto,
      },
      async (tx) => {
        const rows = await tx.$queryRaw<{ id: string }[]>`
          SELECT "id" FROM "Booking" WHERE "id" = ${bookingId} FOR UPDATE`;
        if (rows.length === 0) throw new NotFoundException('Booking not found');
        const booking = await tx.booking.findUniqueOrThrow({
          where: { id: bookingId },
          include: { departure: { include: { tourRef: true } } },
        });
        const billing = booking.billing as BillingData;
        const docType = dto.docType ?? billing.docType ?? 'BOLETA';

        let totalCents: number;
        let paymentKind: string | undefined;
        if (dto.paymentId) {
          const payment = await tx.payment.findUnique({
            where: { id: dto.paymentId },
            include: { documents: { where: COUNTED } },
          });
          if (!payment || payment.bookingId !== bookingId) {
            throw new NotFoundException('Payment not found in this booking');
          }
          if (
            !['SUCCEEDED', 'PARTIALLY_REFUNDED', 'DISPUTED'].includes(
              payment.status,
            )
          ) {
            throw new ConflictException(
              `A ${payment.status} payment has no document`,
            );
          }
          if (payment.documents.length > 0) {
            throw new ConflictException('That payment already has a document');
          }
          // Tampoco se documenta dos veces lo que ya cubre un comprobante de toda la reserva.
          const undocumented = await this.undocumentedCents(tx, booking);
          totalCents = Math.min(
            payment.amountCents - payment.refundedCents,
            undocumented,
          );
          paymentKind = payment.kind;
        } else {
          totalCents = await this.undocumentedCents(tx, booking);
        }
        if (totalCents <= 0) {
          throw new ConflictException('There is nothing left to document');
        }
        const doc = await this.createInTx(tx, {
          booking,
          paymentId: dto.paymentId ?? null,
          paymentKind,
          docType,
          totalCents,
          actorUserId: actor.id,
        });
        return { status: 202, body: { documentId: doc.id } };
      },
    );
    return {
      status: result.status,
      body: await this.get(result.body.documentId),
    };
  }

  /**
   * Emisión automática al confirmarse un pago (si `autoIssueDocuments` está
   * activo). Idempotente: un pago con comprobante (aunque esté anulado) no se
   * vuelve a emitir. Devuelve `false` si no corresponde o no se pudo.
   */
  async autoIssueForPayment(paymentId: string): Promise<boolean> {
    if (!(await this.autoIssueEnabled())) return false;
    const head = await this.prisma.payment.findUnique({
      where: { id: paymentId },
      select: { bookingId: true },
    });
    if (!head) return false;
    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "Booking" WHERE "id" = ${head.bookingId} FOR UPDATE`;
        const payment = await tx.payment.findUniqueOrThrow({
          where: { id: paymentId },
          include: {
            documents: { select: { id: true } },
            refunds: { where: { status: 'PENDING' }, select: { id: true } },
          },
        });
        if (
          !['SUCCEEDED', 'PARTIALLY_REFUNDED'].includes(payment.status) ||
          payment.documents.length > 0 ||
          payment.refunds.length > 0
        ) {
          return false;
        }
        const totalCents = payment.amountCents - payment.refundedCents;
        if (totalCents <= 0) return false;
        const booking = await tx.booking.findUniqueOrThrow({
          where: { id: head.bookingId },
          include: { departure: { include: { tourRef: true } } },
        });
        const billing = booking.billing as BillingData;
        await this.createInTx(tx, {
          booking,
          paymentId,
          paymentKind: payment.kind,
          docType: billing.docType ?? 'BOLETA',
          totalCents,
          auto: true,
        });
        return true;
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Auto-issue for payment ${paymentId} failed: ${message}`,
      );
      await this.alertOnce('document_auto_issue_failed', {
        paymentId,
        reason: message,
      });
      return false;
    }
  }

  // ---------------------------------------------------- Notas de crédito

  private async creditable(tx: Tx, doc: { id: string; totalCents: number }) {
    const sum = await tx.document.aggregate({
      where: { relatedDocumentId: doc.id, docType: 'NOTA_CREDITO', ...COUNTED },
      _sum: { totalCents: true },
    });
    return doc.totalCents - (sum._sum.totalCents ?? 0);
  }

  /** Crea la nota de crédito (y su trabajo de envío). La reserva debe estar bloqueada. */
  private async createCreditNoteInTx(
    tx: Tx,
    related: Doc,
    amountCents: number,
    reason: string,
    reasonCode: string,
    actorUserId?: string,
  ): Promise<Doc | null> {
    const wanted = related.docType === 'FACTURA' ? 'F' : 'B';
    const company = await tx.company.findFirst({ where: { active: true } });
    const series = company
      ? await tx.series.findFirst({
          where: {
            companyId: company.id,
            docType: 'NOTA_CREDITO',
            active: true,
            prefix: { startsWith: wanted },
          },
          orderBy: { prefix: 'asc' },
        })
      : null;
    if (!series || !company) return null;

    const number = await this.nextNumber(tx, series.id);
    const { taxableCents, igvCents } = splitIgv(
      amountCents,
      rateToBps(company.igvRate.toFixed(4)),
    );
    const doc = await tx.document.create({
      data: {
        bookingId: related.bookingId,
        paymentId: related.paymentId,
        seriesId: series.id,
        number,
        docType: 'NOTA_CREDITO',
        status: 'PENDING',
        currency: related.currency,
        totalCents: amountCents,
        taxableCents,
        igvCents,
        exchangeRate: related.exchangeRate,
        customerSnapshot: related.customerSnapshot as Prisma.InputJsonValue,
        relatedDocumentId: related.id,
        reasonCode,
        reason,
      },
      include: { series: true },
    });
    const emit = this.baseRequest(doc, {
      igvRate: company.igvRate.toFixed(4),
      issueDate: limaDate(new Date()),
      customer: related.customerSnapshot as unknown as EmitRequest['customer'],
      items: [
        {
          description: reason.slice(0, 250),
          quantity: 1,
          unitPriceCents: amountCents,
          totalCents: amountCents,
        },
      ],
      affectedDocument: {
        docType: related.docType as 'BOLETA' | 'FACTURA',
        series: related.series.prefix,
        number: related.number,
      },
      reasonCode,
      reason,
    });
    await this.enqueue(tx, doc.id, 'SYNC', { emit });
    await this.audit.record(
      {
        actorUserId,
        action: 'document.credit_note',
        entity: 'Document',
        entityId: doc.id,
        after: {
          relatedDocumentId: related.id,
          number: documentNumber(series.prefix, number),
          amountCents,
          reasonCode,
        },
      },
      tx,
    );
    return doc;
  }

  async createCreditNote(
    documentId: string,
    dto: CreditNoteDto,
    actor: AuthUser,
  ) {
    const head = await this.prisma.document.findUnique({
      where: { id: documentId },
      select: { bookingId: true },
    });
    if (!head) throw new NotFoundException('Document not found');
    const created = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Booking" WHERE "id" = ${head.bookingId} FOR UPDATE`;
      const related = await tx.document.findUniqueOrThrow({
        where: { id: documentId },
        include: { series: true },
      });
      if (related.docType !== 'BOLETA' && related.docType !== 'FACTURA') {
        throw new ConflictException('Only a boleta or factura can be credited');
      }
      if (related.status !== 'ACCEPTED' && related.status !== 'ISSUED') {
        throw new ConflictException(
          `A ${related.status} document cannot be credited`,
        );
      }
      const left = await this.creditable(tx, related);
      if (dto.amountCents > left) {
        throw new ConflictException({
          message: 'The amount exceeds what is left to credit',
          details: { creditableCents: Math.max(0, left) },
        });
      }
      const doc = await this.createCreditNoteInTx(
        tx,
        related,
        dto.amountCents,
        dto.reason,
        dto.amountCents === related.totalCents
          ? CREDIT_NOTE_REASON.FULL_RETURN
          : CREDIT_NOTE_REASON.VALUE_DECREASE,
        actor.id,
      );
      if (!doc) {
        throw new ConflictException(
          'No active credit note series is configured',
        );
      }
      return doc;
    });
    return this.get(created.id);
  }

  /**
   * Nota de crédito automática al cumplirse un reembolso: sobre los
   * comprobantes de ese pago (o de la reserva) con saldo por acreditar. Corre
   * dentro de la transacción del reembolso y nunca la hace fallar: sin
   * serie configurada solo avisa. La reserva ya está bloqueada.
   */
  async creditNoteForRefund(
    tx: Tx,
    refund: { id: string; paymentId: string; amountCents: number },
  ): Promise<void> {
    if (!(await this.autoIssueEnabled(tx))) return;
    const payment = await tx.payment.findUniqueOrThrow({
      where: { id: refund.paymentId },
    });
    const docs = await tx.document.findMany({
      where: {
        bookingId: payment.bookingId,
        docType: { in: ['BOLETA', 'FACTURA'] },
        status: { in: ['PENDING', 'ISSUED', 'ACCEPTED'] },
      },
      include: { series: true },
      orderBy: { createdAt: 'desc' },
    });
    // Primero los comprobantes del propio pago, luego los de toda la reserva.
    docs.sort(
      (a, b) =>
        Number(b.paymentId === payment.id) - Number(a.paymentId === payment.id),
    );
    let left = refund.amountCents;
    let first: string | null = null;
    for (const doc of docs) {
      if (left <= 0) break;
      const room = await this.creditable(tx, doc);
      const take = Math.min(room, left);
      if (take <= 0) continue;
      const note = await this.createCreditNoteInTx(
        tx,
        doc,
        take,
        `Devolución ${refund.id.slice(0, 8)}`,
        take === doc.totalCents
          ? CREDIT_NOTE_REASON.FULL_RETURN
          : CREDIT_NOTE_REASON.VALUE_DECREASE,
      );
      if (!note) {
        void this.alertOnce('credit_note_series_missing', {
          refundId: refund.id,
          docType: doc.docType,
        });
        return;
      }
      first ??= note.id;
      left -= take;
    }
    if (first) {
      await tx.refund.update({
        where: { id: refund.id },
        data: { creditNoteId: first },
      });
    }
  }

  // ------------------------------------------------- Reintento y anulación

  async retry(id: string, actor: AuthUser) {
    const head = await this.prisma.document.findUnique({
      where: { id },
      select: { bookingId: true },
    });
    if (!head) throw new NotFoundException('Document not found');
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Booking" WHERE "id" = ${head.bookingId} FOR UPDATE`;
      const doc = await tx.document.findUniqueOrThrow({ where: { id } });
      const live = await tx.documentJob.count({
        where: { documentId: id, status: 'PENDING' },
      });
      const dead = await tx.documentJob.findFirst({
        where: { documentId: id, kind: 'SYNC' },
        orderBy: { createdAt: 'desc' },
      });
      const retryable =
        doc.status === 'ERROR' ||
        doc.status === 'REJECTED' ||
        (doc.status === 'PENDING' && live === 0);
      if (!retryable || !dead?.payload) {
        throw new ConflictException(
          `A ${doc.status} document cannot be retried`,
        );
      }
      // Misma petición (misma externalId y mismo contenido) que el primer intento.
      await tx.document.update({
        where: { id },
        data: { status: 'PENDING', sunatCode: null, sunatMessage: null },
      });
      await tx.documentJob.create({
        data: {
          documentId: id,
          kind: 'SYNC',
          payload: dead.payload,
          status: 'PENDING',
        },
      });
      await this.audit.record(
        {
          actorUserId: actor.id,
          action: 'document.retry',
          entity: 'Document',
          entityId: id,
          before: { status: doc.status },
          after: { status: 'PENDING' },
        },
        tx,
      );
    });
    return this.get(id);
  }

  async void(id: string, dto: VoidDocumentDto, actor: AuthUser) {
    const head = await this.prisma.document.findUnique({
      where: { id },
      select: { bookingId: true },
    });
    if (!head) throw new NotFoundException('Document not found');
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Booking" WHERE "id" = ${head.bookingId} FOR UPDATE`;
      const doc = await tx.document.findUniqueOrThrow({ where: { id } });
      if (doc.status !== 'ACCEPTED' && doc.status !== 'ISSUED') {
        throw new ConflictException(
          `A ${doc.status} document cannot be voided`,
        );
      }
      const pending = await tx.documentJob.count({
        where: { documentId: id, kind: 'VOID', status: 'PENDING' },
      });
      if (pending > 0) {
        throw new ConflictException('A void is already in progress');
      }
      await this.enqueue(tx, id, 'VOID', {
        void: { reason: dto.reason, voidDate: limaDate(new Date()) },
      });
      await this.audit.record(
        {
          actorUserId: actor.id,
          action: 'document.void_requested',
          entity: 'Document',
          entityId: id,
          after: { reason: dto.reason },
        },
        tx,
      );
    });
    return this.get(id);
  }

  // ----------------------------------------------------------- Lectura

  async list(q: DocumentsQuery) {
    const where: Prisma.DocumentWhereInput = {
      ...(q.status ? { status: q.status } : {}),
      ...(q.docType ? { docType: q.docType } : {}),
      ...(q.from || q.to
        ? {
            createdAt: {
              ...(q.from ? { gte: new Date(q.from) } : {}),
              ...(q.to ? { lte: new Date(q.to) } : {}),
            },
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.document.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        include: WITH_SERIES,
        ...skipTake(q),
      }),
      this.prisma.document.count({ where }),
    ]);
    return paginated(
      rows.map((d) => toDocumentDto(d, d.booking.reference)),
      q,
      total,
    );
  }

  async get(id: string) {
    const row = await this.prisma.document.findUnique({
      where: { id },
      include: WITH_SERIES,
    });
    if (!row) throw new NotFoundException('Document not found');
    return toDocumentDto(row, row.booking.reference);
  }

  /** Archivo guardado (XML, CDR o PDF) con el nombre sugerido para descargarlo. */
  async file(id: string, kind: FileKind) {
    const doc = await this.prisma.document.findUnique({
      where: { id },
      include: { series: true },
    });
    if (!doc) throw new NotFoundException('Document not found');
    const key = doc[FILE_KEY[kind]];
    const data = key ? await this.storage.get(key) : null;
    if (!data) throw new NotFoundException('The file is not available');
    const { contentType, ext } = FILE_TYPES[kind];
    return {
      data,
      contentType,
      filename: `${documentNumber(doc.series.prefix, doc.number)}.${ext}`,
    };
  }
}
