import { splitIgv, rateToBps } from '../../common/money';
import {
  BillingClient,
  BillingError,
  BillingFile,
  BillingFileKind,
  EmitRequest,
  EmitResult,
  TicketResult,
} from './billing-client';

interface Stored {
  request: EmitRequest;
  result: EmitResult;
}

const canonical = (value: unknown): string =>
  JSON.stringify(value, (_k, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) =>
            a < b ? -1 : 1,
          ),
        )
      : v,
  );

/**
 * `desertica-billing` simulado en memoria, con las reglas de `billing.yaml`:
 * idempotente por `externalId` (misma clave con otro contenido: 409), serie y
 * número únicos, `exchangeRate` obligatorio en USD, motivo y comprobante
 * afectado obligatorios en notas, y total igual a la suma de los ítems. No
 * firma ni habla con SUNAT.
 */
export class FakeBillingClient implements BillingClient {
  readonly documents = new Map<string, Stored>();
  readonly tickets = new Map<string, TicketResult & { externalId: string }>();
  /** Cuántas veces se llamó a `emit` (incluye reintentos). */
  emitCalls = 0;
  /** `externalId` de cada llamada a `emit`, en orden. */
  readonly emitLog: string[] = [];
  /** Resultados guionados para las próximas llamadas a `emit`, en orden. */
  private script: {
    outcome: BillingError | EmitResult['status'];
    externalId?: string;
  }[] = [];
  /** Cuántas consultas de un ticket responden `PENDING` antes de aceptarlo. */
  pendingPolls = 0;
  /** Archivos que existen tras emitir. */
  files: BillingFileKind[] = ['xml', 'cdr', 'pdf'];
  private ticketSeq = 0;

  /**
   * La próxima emisión (de ese `externalId`, si se indica) falla con este
   * error, reintentable o no.
   */
  failNext(error: BillingError, times = 1, externalId?: string): void {
    for (let i = 0; i < times; i++) {
      this.script.push({ outcome: error, externalId });
    }
  }

  /** La próxima emisión (de ese `externalId`, si se indica) termina con este estado. */
  statusNext(status: EmitResult['status'], externalId?: string): void {
    this.script.push({ outcome: status, externalId });
  }

  clearScript(): void {
    this.script = [];
  }

  emitsFor(externalId: string): number {
    return this.emitLog.filter((id) => id === externalId).length;
  }

  emit(request: EmitRequest): Promise<EmitResult> {
    this.emitCalls++;
    this.emitLog.push(request.externalId);
    try {
      return Promise.resolve(this.doEmit(request));
    } catch (error) {
      return Promise.reject(error as Error);
    }
  }

  private doEmit(request: EmitRequest): EmitResult {
    const at = this.script.findIndex(
      (s) => !s.externalId || s.externalId === request.externalId,
    );
    const scripted = at >= 0 ? this.script.splice(at, 1)[0].outcome : undefined;
    if (scripted instanceof BillingError) throw scripted;

    const existing = this.documents.get(request.externalId);
    if (existing) {
      if (canonical(existing.request) !== canonical(request)) {
        throw new BillingError(
          'externalId already used with other content',
          'IDEMPOTENCY_CONFLICT',
          409,
          false,
        );
      }
      return existing.result;
    }
    for (const other of this.documents.values()) {
      if (
        other.request.series === request.series &&
        other.request.number === request.number
      ) {
        throw new BillingError(
          'Series and number already used',
          'SERIES_NUMBER_IN_USE',
          409,
          false,
        );
      }
    }
    this.validate(request);
    const { taxableCents, igvCents } = splitIgv(
      request.totalCents,
      rateToBps(request.igvRate),
    );
    const status = typeof scripted === 'string' ? scripted : 'ACCEPTED';
    const ok = status === 'ACCEPTED' || status === 'ISSUED';
    const result: EmitResult = {
      externalId: request.externalId,
      status,
      taxableCents,
      igvCents,
      totalCents: request.totalCents,
      hash: `hash-${request.series}-${request.number}`,
      sunatCode:
        status === 'ACCEPTED' ? '0' : status === 'REJECTED' ? '2800' : null,
      sunatMessage:
        status === 'ACCEPTED'
          ? `La Factura numero ${request.series}-${request.number}, ha sido aceptada`
          : status === 'REJECTED'
            ? 'Rechazado por SUNAT (simulado)'
            : null,
      ticket: null,
      files: {
        xml: ok && this.files.includes('xml'),
        cdr: status === 'ACCEPTED' && this.files.includes('cdr'),
        pdf: ok && this.files.includes('pdf'),
      },
    };
    this.documents.set(request.externalId, { request, result });
    return result;
  }

  private validate(r: EmitRequest): void {
    const invalid = (message: string) =>
      new BillingError(message, 'VALIDATION_ERROR', 422, false);
    if (r.currency === 'USD' && !r.exchangeRate) {
      throw invalid('exchangeRate is required for USD');
    }
    if (
      (r.docType === 'NOTA_CREDITO' || r.docType === 'NOTA_DEBITO') &&
      (!r.affectedDocument || !r.reasonCode)
    ) {
      throw invalid('affectedDocument and reasonCode are required for notes');
    }
    if (r.items.length === 0) throw invalid('items are required');
    if (r.items.reduce((n, i) => n + i.totalCents, 0) !== r.totalCents) {
      throw invalid('totalCents must equal the sum of the items');
    }
    if (r.docType === 'FACTURA' && r.customer.idDocType !== 'RUC') {
      throw invalid('A factura needs a RUC receptor');
    }
  }

  getStatus(externalId: string): Promise<EmitResult | null> {
    return Promise.resolve(this.documents.get(externalId)?.result ?? null);
  }

  downloadFile(
    externalId: string,
    kind: BillingFileKind,
  ): Promise<BillingFile | null> {
    const stored = this.documents.get(externalId);
    if (!stored || !stored.result.files?.[kind]) return Promise.resolve(null);
    const body: Record<BillingFileKind, BillingFile> = {
      xml: {
        data: Buffer.from(`<Invoice id="${externalId}"/>`),
        contentType: 'application/xml',
      },
      cdr: {
        data: Buffer.from(`PK-fake-cdr-${externalId}`),
        contentType: 'application/zip',
      },
      pdf: {
        data: Buffer.from(`%PDF-1.4 fake ${externalId}`),
        contentType: 'application/pdf',
      },
    };
    return Promise.resolve(body[kind]);
  }

  void(
    externalId: string,
    request: { reason: string; voidDate: string },
  ): Promise<TicketResult> {
    const stored = this.documents.get(externalId);
    if (!stored) {
      return Promise.reject(
        new BillingError('Unknown', 'NOT_FOUND', 404, false),
      );
    }
    if (
      stored.result.status !== 'ACCEPTED' &&
      stored.result.status !== 'ISSUED'
    ) {
      return Promise.reject(
        new BillingError('Not voidable', 'NOT_VOIDABLE', 409, false),
      );
    }
    void request;
    const ticket = `T-${++this.ticketSeq}-${externalId.slice(0, 8)}`;
    const result: TicketResult & { externalId: string } = {
      ticket,
      status: 'PENDING',
      externalId,
    };
    this.tickets.set(ticket, result);
    return Promise.resolve({ ticket, status: 'PENDING' });
  }

  getTicket(ticket: string): Promise<TicketResult | null> {
    const t = this.tickets.get(ticket);
    if (!t) return Promise.resolve(null);
    if (t.status === 'PENDING') {
      if (this.pendingPolls > 0) {
        this.pendingPolls--;
        return Promise.resolve({ ticket, status: 'PENDING' });
      }
      t.status = 'ACCEPTED';
      const stored = this.documents.get(t.externalId);
      if (stored) stored.result = { ...stored.result, status: 'VOIDED' };
    }
    return Promise.resolve({
      ticket,
      status: t.status,
      sunatCode: '0',
      sunatMessage: 'Comunicación de baja aceptada (simulada)',
    });
  }
}
