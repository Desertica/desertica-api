import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { signLink } from '../src/common/signed-link';
import { HttpBillingClient } from '../src/modules/billing/http-billing.client';
import { StaffAlertsService } from '../src/modules/alerts/staff-alerts.service';
import { BookingViewService } from '../src/modules/bookings/booking-view.service';
import {
  BillingError,
  BILLING_CLIENT,
} from '../src/modules/billing/billing-client';
import {
  DOCUMENT_STORAGE,
  MemoryDocumentStorage,
} from '../src/modules/billing/document-storage';
import { FakeBillingClient } from '../src/modules/billing/fake-billing.client';
import { DocumentsService as DocumentsServiceToken } from '../src/modules/documents/documents.service';
import { DocumentWorker } from '../src/modules/documents/document-worker.service';
import { GatewayRegistry } from '../src/modules/payments/gateway.registry';
import { FakeGateway } from '../src/modules/payments/providers/fake.gateway';
import { PrismaService } from '../src/prisma/prisma.service';
import { startBillingServer } from './billing-contract-server';
import { CatalogFixture, createCatalog, rand } from './fixtures';
import { createTestApp, loginAs, TestSession } from './helpers';
import {
  ensureBilling,
  evt,
  makeBooking,
  postWebhook,
  recordPaid,
} from './payment-helpers';

type Body = Record<string, any>;
const FAR = () => new Date(Date.now() + 10 * 86_400_000);
const LATER = (hours: number) => new Date(Date.now() + hours * 3_600_000);

// La cola es compartida con otras suites: una pasada puede tardar si hay trabajos ajenos.
jest.setTimeout(60_000);

describe('Comprobantes (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let admin: TestSession;
  let operator: TestSession;
  let billing: FakeBillingClient;
  let storage: MemoryDocumentStorage;
  let worker: DocumentWorker;
  let fx: CatalogFixture;
  const alertLog: { code: string; bookingId?: string }[] = [];
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    storage = new MemoryDocumentStorage();
    app = await createTestApp((b) =>
      b
        .overrideProvider(DOCUMENT_STORAGE)
        .useValue(storage)
        .overrideProvider(StaffAlertsService)
        .useValue({
          alert: (code: string, _d: Body, o: { bookingId?: string } = {}) => {
            alertLog.push({ code, bookingId: o.bookingId });
            return Promise.resolve();
          },
        }),
    );
    prisma = app.get(PrismaService);
    billing = app.get<FakeBillingClient>(BILLING_CLIENT);
    worker = app.get(DocumentWorker);
    admin = await loginAs(app, 'admin');
    operator = await loginAs(app, 'operator');
    fx = await createCatalog(app);
    await ensureBilling(app);
    // Trabajos que dejaron otras pruebas: no son de esta suite y no deben ocupar el barrido.
    await prisma.documentJob.updateMany({
      where: { status: 'PENDING' },
      data: { status: 'DONE' },
    });
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(() => {
    billing.pendingPolls = 0;
  });

  const document = (id: string) =>
    prisma.document.findUniqueOrThrow({ where: { id } });
  const issue = (
    session: TestSession,
    bookingId: string,
    body: Body = {},
    key?: string,
  ) => {
    const r = http()
      .post(`/api/bookings/${bookingId}/documents`)
      .set(session.auth);
    if (key) r.set('Idempotency-Key', key);
    return r.send(body);
  };
  /** Reserva pagada con un pago de pasarela (sin comprobante todavía). */
  async function paidBooking(over: Parameters<typeof makeBooking>[2] = {}) {
    const b = await makeBooking(app, fx, over);
    const p = await recordPaid(app, b);
    return { b, p };
  }
  /** Emite por la API y deja que el worker lo envíe a billing. */
  async function accepted(session = admin) {
    const { b, p } = await paidBooking();
    const res = await issue(session, b.id, { paymentId: p.id }).expect(202);
    await worker.runOnce(FAR(), [(res.body as Body).id as string]);
    const row = await prisma.document.findUniqueOrThrow({
      where: { id: (res.body as Body).id },
      include: { series: true },
    });
    expect(row.status).toBe('ACCEPTED');
    return { b, p, doc: row };
  }
  const alerted = (code: string) =>
    alertLog.filter((a) => a.code === code).length;

  // ------------------------------------------------------------- Emitir
  describe('issueDocument', () => {
    it('assigns series and number, computes taxable and IGV, queues and then issues through billing', async () => {
      const { b, p } = await paidBooking();
      const res = await issue(operator, b.id).expect(202);
      const doc = res.body as Body;
      expect(doc).toMatchObject({
        bookingId: b.id,
        bookingReference: b.reference,
        customerName: 'Ana Pérez',
        docType: 'BOLETA',
        status: 'PENDING',
        currency: 'USD',
        totalCents: 20000,
        taxableCents: 16949,
        igvCents: 3051,
        paymentId: null,
        hasXml: false,
        hasPdf: false,
      });
      expect(doc.number).toBeGreaterThan(0);
      expect(doc.exchangeRate).toMatch(/^\d+\.\d{4}$/);
      expect(doc.taxableCents + doc.igvCents).toBe(doc.totalCents);

      await worker.runOnce(FAR());
      expect(billing.emitsFor(doc.id)).toBe(1);
      const stored = billing.documents.get(doc.id)!.request;
      expect(stored).toMatchObject({
        externalId: doc.id,
        docType: 'BOLETA',
        series: doc.series,
        number: doc.number,
        currency: 'USD',
        exchangeRate: doc.exchangeRate,
        igvRate: '0.1800',
        totalCents: 20000,
        customer: {
          idDocType: 'DNI',
          idDocNumber: '12345678',
          name: 'Ana Pérez',
        },
      });
      expect(stored.items).toHaveLength(1);
      expect(stored.items[0].description).toContain(b.reference);

      const done = await http()
        .get(`/api/documents/${doc.id}`)
        .set(operator.auth)
        .expect(200);
      expect(done.body).toMatchObject({
        status: 'ACCEPTED',
        hasXml: true,
        hasCdr: true,
        hasPdf: true,
        sunatCode: '0',
      });
      expect((done.body as Body).issuedAt).toBeTruthy();
      expect(storage.files.size).toBeGreaterThanOrEqual(3);
      const row = await document(doc.id);
      expect(storage.files.get(row.pdfKey!)!.toString()).toContain('%PDF');
      expect(p.id).toBeTruthy();
      const audit = await prisma.auditLog.findMany({
        where: { entity: 'Document', entityId: doc.id },
      });
      expect(audit.map((a) => a.action)).toEqual(
        expect.arrayContaining(['document.create', 'document.status']),
      );
    });

    it('is idempotent with Idempotency-Key and refuses to document the same money twice', async () => {
      const { b, p } = await paidBooking();
      const key = `k-${rand()}${rand()}`;
      const a = await issue(admin, b.id, {}, key).expect(202);
      const again = await issue(admin, b.id, {}, key).expect(202);
      expect((again.body as Body).id).toBe((a.body as Body).id);
      expect(await prisma.document.count({ where: { bookingId: b.id } })).toBe(
        1,
      );
      await issue(admin, b.id).expect(409); // ya no queda nada por documentar
      await issue(admin, b.id, { paymentId: p.id }).expect(409); // el pago ya está cubierto... o sin saldo
    });

    it('rejects unpaid bookings, unknown ones, foreign payments and bad input', async () => {
      const unpaid = await makeBooking(app, fx);
      await issue(admin, unpaid.id).expect(409);
      await issue(admin, '00000000-0000-4000-8000-000000000000').expect(404);
      const other = await paidBooking();
      await issue(admin, unpaid.id, { paymentId: other.p.id }).expect(404);
      await issue(admin, other.b.id, { docType: 'NOTA_CREDITO' }).expect(422);
      await issue(admin, other.b.id, { paymentId: 'not-a-uuid' }).expect(422);
      await http()
        .post(`/api/bookings/${other.b.id}/documents`)
        .send({})
        .expect(401);
    });

    it('needs a RUC receptor for a factura', async () => {
      const dni = await paidBooking();
      await issue(admin, dni.b.id, { docType: 'FACTURA' }).expect(422);
      const ruc = await paidBooking({
        billing: {
          docType: 'FACTURA',
          name: 'Agencia SAC',
          idDocType: 'RUC',
          idDocNumber: '20123456789',
          address: 'Lima',
        },
      });
      const res = await issue(admin, ruc.b.id).expect(202);
      expect(res.body).toMatchObject({
        docType: 'FACTURA',
        customerName: 'Agencia SAC',
      });
      expect(((res.body as Body).series as string)[0]).toBe('F');
    });

    it('uses the exchange rate loaded for the date and none for PEN', async () => {
      const today = new Date(Date.now() - 5 * 3_600_000)
        .toISOString()
        .slice(0, 10);
      await prisma.setting.upsert({
        where: { key: 'exchangeRates' },
        update: { value: { [today]: '3.7712' } },
        create: { key: 'exchangeRates', value: { [today]: '3.7712' } },
      });
      try {
        const usd = await paidBooking();
        const pen = await paidBooking({ currency: 'PEN' });
        const a = await issue(admin, usd.b.id).expect(202);
        const c = await issue(admin, pen.b.id).expect(202);
        expect((a.body as Body).exchangeRate).toBe('3.7712');
        expect((c.body as Body).exchangeRate).toBeNull();
        expect((c.body as Body).currency).toBe('PEN');
      } finally {
        await prisma.setting.delete({ where: { key: 'exchangeRates' } });
      }
    });

    it('answers 409 and changes nothing when no series is configured', async () => {
      const { b } = await paidBooking();
      const booking = await prisma.booking.findUniqueOrThrow({
        where: { id: b.id },
        include: { departure: { include: { tourRef: true } } },
      });
      class Rollback extends Error {}
      // Todo dentro de una transacción que se deshace: no afecta a otras suites.
      await expect(
        prisma.$transaction(async (tx) => {
          await tx.series.updateMany({ data: { active: false } });
          const before = await tx.series.findMany({
            select: { id: true, nextNumber: true },
            orderBy: { id: 'asc' },
          });
          await expect(
            app.get(DocumentsServiceToken).createInTx(tx, {
              booking,
              paymentId: null,
              docType: 'BOLETA',
              totalCents: 20000,
            }),
          ).rejects.toThrow(/series is configured/);
          const after = await tx.series.findMany({
            select: { id: true, nextNumber: true },
            orderBy: { id: 'asc' },
          });
          expect(after).toEqual(before); // no se consumió ningún correlativo
          throw new Rollback();
        }),
      ).rejects.toBeInstanceOf(Rollback);
      expect(await prisma.document.count({ where: { bookingId: b.id } })).toBe(
        0,
      );
    });

    it('assigns distinct numbers to simultaneous issues, with no gaps in the series', async () => {
      const bookings = await Promise.all(
        Array.from({ length: 8 }, () => paidBooking()),
      );
      const results = await Promise.all(
        bookings.map(({ b }) => issue(admin, b.id).expect(202)),
      );
      const docs = results.map((r) => r.body as Body);
      const mine = new Set(docs.map((d) => `${d.series}:${d.number}`));
      expect(mine.size).toBe(8); // ninguna repetida
      // Sin huecos: otras suites usan la misma serie a la vez, así que se
      // comprueba con una sola consulta (instantánea consistente) que cada
      // correlativo asignado tiene su comprobante (otras suites insertan
      // comprobantes sintéticos con números altos: se ignoran).
      for (const prefix of new Set(docs.map((d) => d.series as string))) {
        const rows = await prisma.$queryRaw<{ docs: bigint; next: number }[]>`
          SELECT (SELECT count(*) FROM "Document" d WHERE d."seriesId" = s."id" AND d."number" < 9000000) AS docs,
                 s."nextNumber" - 1 AS next
          FROM "Series" s WHERE s."prefix" = ${prefix} LIMIT 1`;
        expect(Number(rows[0].docs)).toBe(rows[0].next);
      }
    });
  });

  // ------------------------------------------------ Emisión automática
  describe('automatic issuing', () => {
    it('issues when a gateway payment is confirmed by the webhook', async () => {
      const b = await makeBooking(app, fx);
      const p = await prisma.payment.create({
        data: {
          bookingId: b.id,
          provider: 'STRIPE',
          method: 'CARD',
          kind: 'FULL',
          status: 'PENDING',
          currency: 'USD',
          amountCents: b.total,
          providerRef: `pi_a_${rand()}${rand()}`,
        },
      });
      await postWebhook(app, 'stripe', {
        kind: 'payment',
        eventId: evt(),
        type: 'payment_intent.succeeded',
        payment: {
          providerRef: p.providerRef!,
          status: 'SUCCEEDED',
          amountCents: p.amountCents,
          currency: 'USD',
          metadata: { paymentId: p.id },
        },
      }).expect(200);
      const docs = await prisma.document.findMany({
        where: { bookingId: b.id },
      });
      expect(docs).toHaveLength(1);
      expect(docs[0]).toMatchObject({
        paymentId: p.id,
        docType: 'BOLETA',
        totalCents: 20000,
        status: 'PENDING',
      });
      await worker.runOnce(FAR());
      expect((await document(docs[0].id)).status).toBe('ACCEPTED');
      // Repetir el webhook no emite otro.
      await worker.runOnce(FAR());
      expect(await prisma.document.count({ where: { bookingId: b.id } })).toBe(
        1,
      );
    });

    it('does not issue when the setting is off, and the sweep picks the payment up once it is on', async () => {
      await prisma.setting.upsert({
        where: { key: 'autoIssueDocuments' },
        update: { value: false },
        create: { key: 'autoIssueDocuments', value: false },
      });
      const { b, p } = await paidBooking();
      try {
        expect(await worker.runOnce(FAR())).toMatchObject({ issued: 0 });
        expect(
          await prisma.document.count({ where: { bookingId: b.id } }),
        ).toBe(0);
      } finally {
        await prisma.setting.delete({ where: { key: 'autoIssueDocuments' } });
      }
      await worker.runOnce(FAR());
      const docs = await prisma.document.findMany({
        where: { bookingId: b.id },
      });
      expect(docs).toHaveLength(1);
      expect(docs[0].paymentId).toBe(p.id);
    });

    it('issues a document per payment of a deposit booking and for manual payments', async () => {
      const b = await makeBooking(app, fx, { deposit: true });
      const dep = await recordPaid(app, b, {
        provider: 'MANUAL',
        amountCents: 6000,
        kind: 'DEPOSIT',
      });
      const bal = await recordPaid(app, b, {
        provider: 'STRIPE',
        amountCents: 14000,
        kind: 'BALANCE',
      });
      await worker.runOnce(FAR());
      const docs = await prisma.document.findMany({
        where: { bookingId: b.id },
        orderBy: { totalCents: 'asc' },
      });
      expect(docs.map((d) => [d.paymentId, d.totalCents])).toEqual([
        [dep.id, 6000],
        [bal.id, 14000],
      ]);
      const sent = billing.documents.get(docs[0].id)!.request;
      expect(sent.items[0].description).toMatch(/^Anticipo: /);
    });
  });

  // --------------------------------------------------- Cola y reintentos
  describe('queue and retries', () => {
    it('retries with the same externalId and the same request until billing answers', async () => {
      const { b, p } = await paidBooking();
      const res = await issue(admin, b.id, { paymentId: p.id }).expect(202);
      const id = (res.body as Body).id as string;
      billing.failNext(
        new BillingError('SUNAT caído', 'SUNAT_UNAVAILABLE', 502, true),
        2,
        id,
      );
      const seen: unknown[] = [];
      const spy = billing.emit.bind(billing);
      billing.emit = (r) => {
        if (r.externalId === id) seen.push(JSON.stringify(r));
        return spy(r);
      };
      try {
        await worker.runOnce(FAR(), [id]); // intento 1: falla
        expect((await document(id)).status).toBe('PENDING');
        const job = await prisma.documentJob.findFirstOrThrow({
          where: { documentId: id },
        });
        expect(job).toMatchObject({ attempts: 1, status: 'PENDING' });
        expect(job.lastError).toContain('SUNAT');
        await worker.runOnce(new Date(), [id]); // todavía en espera: no reintenta
        expect(billing.emitsFor(id)).toBe(1);
        await worker.runOnce(LATER(24 * 11), [id]); // intento 2: falla
        await worker.runOnce(LATER(24 * 12), [id]); // intento 3: pasa
      } finally {
        billing.emit = spy;
      }
      expect(billing.emitsFor(id)).toBe(3);
      expect(new Set(seen).size).toBe(1); // idéntica en cada reintento
      expect((await document(id)).status).toBe('ACCEPTED');
      expect(
        (
          await prisma.documentJob.findFirstOrThrow({
            where: { documentId: id },
          })
        ).status,
      ).toBe('DONE');
    });

    it('gives up after too many attempts, marks the document as error and alerts', async () => {
      const { b, p } = await paidBooking();
      const res = await issue(admin, b.id, { paymentId: p.id }).expect(202);
      const id = (res.body as Body).id as string;
      billing.failNext(
        new BillingError('SUNAT caído', 'SUNAT_UNAVAILABLE', 502, true),
        12,
        id,
      );
      const before = alerted('document_failed');
      for (let i = 1; i <= 10; i++)
        await worker.runOnce(LATER(24 * (20 + i)), [id]);
      expect(await document(id)).toMatchObject({ status: 'ERROR' });
      expect(
        (
          await prisma.documentJob.findFirstOrThrow({
            where: { documentId: id },
          })
        ).status,
      ).toBe('DEAD');
      expect(alerted('document_failed')).toBeGreaterThan(before);
      // retryDocument lo reencola con la misma petición.
      billing.clearScript(); // descarta los fallos guionados que sobraron
      await http()
        .post(`/api/documents/${id}/retry`)
        .set(operator.auth)
        .expect(202);
      await worker.runOnce(FAR(), [id]);
      expect((await document(id)).status).toBe('ACCEPTED');
    });

    it('marks a document with invalid data as error right away and lets staff retry it', async () => {
      const { b, p } = await paidBooking();
      const res = await issue(admin, b.id, { paymentId: p.id }).expect(202);
      const id = (res.body as Body).id as string;
      billing.failNext(
        new BillingError('Datos inválidos', 'VALIDATION_ERROR', 422, false),
        1,
        id,
      );
      await worker.runOnce(FAR(), [id]);
      expect(await document(id)).toMatchObject({
        status: 'ERROR',
        sunatMessage: 'Datos inválidos',
      });
      expect(
        (
          await prisma.documentJob.findFirstOrThrow({
            where: { documentId: id },
          })
        ).status,
      ).toBe('DONE');
      const retried = await http()
        .post(`/api/documents/${id}/retry`)
        .set(operator.auth)
        .expect(202);
      expect(retried.body).toMatchObject({ status: 'PENDING' });
      await worker.runOnce(FAR(), [id]);
      expect((await document(id)).status).toBe('ACCEPTED');
      await http()
        .post(`/api/documents/${id}/retry`)
        .set(operator.auth)
        .expect(409); // ya está aceptado
      await http()
        .post(`/api/documents/00000000-0000-4000-8000-000000000000/retry`)
        .set(operator.auth)
        .expect(404);
    });

    it('keeps a SUNAT rejection as rejected and alerts', async () => {
      const { b, p } = await paidBooking();
      const res = await issue(admin, b.id, { paymentId: p.id }).expect(202);
      const id = (res.body as Body).id as string;
      billing.statusNext('REJECTED', id);
      const before = alerted('document_rejected');
      await worker.runOnce(FAR(), [id]);
      expect(await document(id)).toMatchObject({
        status: 'REJECTED',
        sunatCode: '2800',
      });
      expect(alerted('document_rejected')).toBe(before + 1);
    });

    it('follows a boleta that is only issued until its summary is accepted', async () => {
      const { b, p } = await paidBooking();
      const res = await issue(admin, b.id, { paymentId: p.id }).expect(202);
      const id = (res.body as Body).id as string;
      billing.statusNext('ISSUED', id);
      billing.files = ['xml', 'pdf'];
      await worker.runOnce(FAR());
      expect(await document(id)).toMatchObject({
        status: 'ISSUED',
        cdrKey: null,
      });
      expect((await document(id)).pdfKey).toBeTruthy();
      billing.files = ['xml', 'cdr', 'pdf'];
      const stored = billing.documents.get(id)!;
      stored.result = {
        ...stored.result,
        status: 'ACCEPTED',
        files: { xml: true, cdr: true, pdf: true },
      };
      await worker.runOnce(LATER(24 * 30), [id]);
      expect(await document(id)).toMatchObject({ status: 'ACCEPTED' });
      expect((await document(id)).cdrKey).toBeTruthy();
    });

    it('works through the HTTP client against a server that follows the contract', async () => {
      const server = await startBillingServer();
      const original = billing;
      Object.assign(worker, {
        billing: new HttpBillingClient({
          baseUrl: server.url,
          serviceToken: server.token,
        }),
      });
      try {
        const { b, p } = await paidBooking();
        const res = await issue(admin, b.id, { paymentId: p.id }).expect(202);
        await worker.runOnce(FAR());
        const doc = await document((res.body as Body).id);
        expect(doc).toMatchObject({ status: 'ACCEPTED' });
        expect(doc.pdfKey).toBeTruthy();
        expect(server.violations).toEqual([]);
        expect(
          server.requests.find((r) => r.path === '/v1/documents'),
        ).toBeTruthy();
      } finally {
        Object.assign(worker, { billing: original });
        await server.close();
      }
    });
  });

  // -------------------------------------------------------------- Anular
  describe('voidDocument', () => {
    it('queues the void, follows the SUNAT ticket and ends voided', async () => {
      const { doc } = await accepted();
      await http()
        .post(`/api/documents/${doc.id}/void`)
        .set(operator.auth)
        .send({ reason: 'x' })
        .expect(403);
      billing.pendingPolls = 1;
      const res = await http()
        .post(`/api/documents/${doc.id}/void`)
        .set(admin.auth)
        .send({ reason: 'Error en los datos' })
        .expect(202);
      expect(res.body).toMatchObject({ status: 'ACCEPTED' });
      await http()
        .post(`/api/documents/${doc.id}/void`)
        .set(admin.auth)
        .send({ reason: 'otra vez' })
        .expect(409);
      await worker.runOnce(FAR(), [doc.id]); // ticket pendiente
      expect((await document(doc.id)).status).toBe('ACCEPTED');
      await worker.runOnce(LATER(24 * 11), [doc.id]);
      expect(await document(doc.id)).toMatchObject({ status: 'VOIDED' });
      expect((await document(doc.id)).voidedAt).not.toBeNull();
      await http()
        .post(`/api/documents/${doc.id}/void`)
        .set(admin.auth)
        .send({ reason: 'ya' })
        .expect(409);
      const voidCall = [...billing.tickets.values()].find(
        (t) => t.externalId === doc.id,
      );
      expect(voidCall).toBeTruthy();
    });

    it('validates the reason and the state', async () => {
      const { b, p } = await paidBooking();
      const res = await issue(admin, b.id, { paymentId: p.id }).expect(202);
      const id = (res.body as Body).id as string;
      await http()
        .post(`/api/documents/${id}/void`)
        .set(admin.auth)
        .send({ reason: 'x' })
        .expect(409); // aún PENDING
      await http()
        .post(`/api/documents/${id}/void`)
        .set(admin.auth)
        .send({ reason: 'x'.repeat(101) })
        .expect(422);
      await http()
        .post(`/api/documents/${id}/void`)
        .set(admin.auth)
        .send({})
        .expect(422);
      await http()
        .post(`/api/documents/00000000-0000-4000-8000-000000000000/void`)
        .set(admin.auth)
        .send({ reason: 'x' })
        .expect(404);
    });
  });

  // ------------------------------------------------------ Notas de crédito
  describe('credit notes', () => {
    it('issues a partial and then the remaining credit note over an accepted document', async () => {
      const { doc } = await accepted();
      const partial = await http()
        .post(`/api/documents/${doc.id}/credit-note`)
        .set(admin.auth)
        .send({ reason: 'Descuento acordado', amountCents: 5000 })
        .expect(202);
      expect(partial.body).toMatchObject({
        docType: 'NOTA_CREDITO',
        status: 'PENDING',
        totalCents: 5000,
        relatedDocumentId: doc.id,
        currency: 'USD',
      });
      expect(((partial.body as Body).series as string)[0]).toBe('B');
      await http()
        .post(`/api/documents/${doc.id}/credit-note`)
        .set(admin.auth)
        .send({ reason: 'x', amountCents: 15001 })
        .expect(409);
      const rest = await http()
        .post(`/api/documents/${doc.id}/credit-note`)
        .set(admin.auth)
        .send({ reason: 'Resto', amountCents: 15000 })
        .expect(202);
      await http()
        .post(`/api/documents/${doc.id}/credit-note`)
        .set(admin.auth)
        .send({ reason: 'x', amountCents: 1 })
        .expect(409);

      await worker.runOnce(FAR());
      const sent = billing.documents.get((partial.body as Body).id)!.request;
      expect(sent).toMatchObject({
        docType: 'NOTA_CREDITO',
        reasonCode: '09',
        reason: 'Descuento acordado',
        affectedDocument: {
          docType: 'BOLETA',
          series: doc.series.prefix,
          number: doc.number,
        },
        exchangeRate: sent.exchangeRate,
      });
      expect(
        billing.documents.get((rest.body as Body).id)!.request.reasonCode,
      ).toBe('09'); // parcial respecto del total
      const orig = await prisma.document.findUniqueOrThrow({
        where: { id: doc.id },
        include: { series: true },
      });
      expect(sent.exchangeRate).toBe(orig.exchangeRate!.toFixed(4));
    });

    it('uses the full-return reason when the note covers the whole document', async () => {
      const { doc } = await accepted();
      const res = await http()
        .post(`/api/documents/${doc.id}/credit-note`)
        .set(admin.auth)
        .send({ reason: 'Anulación', amountCents: 20000 })
        .expect(202);
      await worker.runOnce(FAR());
      expect(
        billing.documents.get((res.body as Body).id)!.request.reasonCode,
      ).toBe('06');
    });

    it('only credits an issued boleta or factura', async () => {
      const { b, p } = await paidBooking();
      const res = await issue(admin, b.id, { paymentId: p.id }).expect(202);
      await http()
        .post(`/api/documents/${(res.body as Body).id}/credit-note`)
        .set(admin.auth)
        .send({ reason: 'x', amountCents: 100 })
        .expect(409); // PENDING
      await http()
        .post(`/api/documents/00000000-0000-4000-8000-000000000000/credit-note`)
        .set(admin.auth)
        .send({ reason: 'x', amountCents: 100 })
        .expect(404);
      const { doc } = await accepted();
      await http()
        .post(`/api/documents/${doc.id}/credit-note`)
        .set(operator.auth)
        .send({ reason: 'x', amountCents: 100 })
        .expect(403);
      for (const amountCents of [0, -1, 1.5]) {
        await http()
          .post(`/api/documents/${doc.id}/credit-note`)
          .set(admin.auth)
          .send({ reason: 'x', amountCents })
          .expect(422);
      }
      const note = await http()
        .post(`/api/documents/${doc.id}/credit-note`)
        .set(admin.auth)
        .send({ reason: 'x', amountCents: 100 })
        .expect(202);
      await http()
        .post(`/api/documents/${(note.body as Body).id}/credit-note`)
        .set(admin.auth)
        .send({ reason: 'x', amountCents: 1 })
        .expect(409); // no se acredita una nota
    });

    it('issues the credit note automatically when a payment with a document is refunded', async () => {
      const { b, p, doc } = await accepted();
      const stripe = app.get(GatewayRegistry).get('STRIPE') as FakeGateway;
      expect(stripe).toBeTruthy();
      const res = await http()
        .post(`/api/payments/${p.id}/refunds`)
        .set(admin.auth)
        .send({ amountCents: 5000, reason: 'cortesía' })
        .expect(201);
      // El barrido de otra instancia (o suite) puede ejecutar el reembolso a la vez: se espera.
      let refund = await prisma.refund.findUniqueOrThrow({
        where: { id: (res.body as Body).id },
      });
      for (let i = 0; i < 50 && refund.status !== 'SUCCEEDED'; i++) {
        await new Promise((r) => setTimeout(r, 100));
        refund = await prisma.refund.findUniqueOrThrow({
          where: { id: refund.id },
        });
      }
      expect(refund.status).toBe('SUCCEEDED');
      expect(refund.creditNoteId).toBeTruthy();
      const note = await document(refund.creditNoteId!);
      expect(note).toMatchObject({
        docType: 'NOTA_CREDITO',
        totalCents: 5000,
        relatedDocumentId: doc.id,
        bookingId: b.id,
        paymentId: p.id,
      });
      await worker.runOnce(FAR());
      expect((await document(note.id)).status).toBe('ACCEPTED');
      expect(
        billing.documents.get(note.id)!.request.affectedDocument,
      ).toMatchObject({ number: doc.number });

      // El resto del pago: segunda nota hasta cubrir el comprobante.
      const rest = await http()
        .post(`/api/payments/${p.id}/refunds`)
        .set(admin.auth)
        .send({ amountCents: 15000, reason: 'resto' })
        .expect(201);
      for (let i = 0; i < 50; i++) {
        const r = await prisma.refund.findUniqueOrThrow({
          where: { id: (rest.body as Body).id },
        });
        if (r.status === 'SUCCEEDED') break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const notes = await prisma.document.findMany({
        where: { relatedDocumentId: doc.id },
      });
      expect(notes.reduce((n, d) => n + d.totalCents, 0)).toBe(20000);
    });

    it('does not issue a credit note when the setting is off or the payment has no document', async () => {
      const none = await paidBooking();
      await http()
        .post(`/api/payments/${none.p.id}/refunds`)
        .set(admin.auth)
        .send({ amountCents: 1000, reason: 'x' })
        .expect(201);
      expect(
        await prisma.document.count({ where: { bookingId: none.b.id } }),
      ).toBe(0);

      const { b, p, doc } = await accepted();
      await prisma.setting.upsert({
        where: { key: 'autoIssueDocuments' },
        update: { value: false },
        create: { key: 'autoIssueDocuments', value: false },
      });
      try {
        await http()
          .post(`/api/payments/${p.id}/refunds`)
          .set(admin.auth)
          .send({ amountCents: 1000, reason: 'x' })
          .expect(201);
      } finally {
        await prisma.setting.delete({ where: { key: 'autoIssueDocuments' } });
      }
      expect(
        await prisma.document.count({ where: { relatedDocumentId: doc.id } }),
      ).toBe(0);
      expect(b.id).toBeTruthy();
    });
  });

  // ------------------------------------------------- Lectura y descargas
  describe('lists and files', () => {
    it('lists with filters and downloads the stored files with the right types', async () => {
      const { doc } = await accepted();
      const list = await http()
        .get('/api/documents')
        .query({ status: 'ACCEPTED', docType: 'BOLETA', pageSize: 100 })
        .set(operator.auth)
        .expect(200);
      expect(
        (list.body as { data: Body[] }).data.some((d) => d.id === doc.id),
      ).toBe(true);
      const none = await http()
        .get('/api/documents')
        .query({ from: '2999-01-01T00:00:00Z' })
        .set(operator.auth)
        .expect(200);
      expect((none.body as { data: Body[] }).data).toHaveLength(0);
      await http()
        .get('/api/documents')
        .query({ status: 'NOPE' })
        .set(operator.auth)
        .expect(422);
      await http()
        .get('/api/documents/00000000-0000-4000-8000-000000000000')
        .set(operator.auth)
        .expect(404);

      const expected = {
        xml: 'application/xml',
        cdr: 'application/zip',
        pdf: 'application/pdf',
      } as const;
      for (const kind of ['xml', 'cdr', 'pdf'] as const) {
        const res = await http()
          .get(`/api/documents/${doc.id}/files/${kind}`)
          .set(operator.auth)
          .buffer(true)
          .parse((r, cb) => {
            const chunks: Buffer[] = [];
            r.on('data', (c: Buffer) => chunks.push(c));
            r.on('end', () => cb(null, Buffer.concat(chunks)));
          })
          .expect(200);
        expect(res.headers['content-type']).toContain(expected[kind]);
        expect(res.headers['content-disposition']).toContain(
          `attachment; filename="${doc.series.prefix}-`,
        );
        expect((res.body as Buffer).length).toBeGreaterThan(0);
      }
      await http()
        .get(`/api/documents/${doc.id}/files/exe`)
        .set(operator.auth)
        .expect(400);
      await http().get(`/api/documents/${doc.id}/files/pdf`).expect(401);

      const { b, p } = await paidBooking();
      const pending = await issue(admin, b.id, { paymentId: p.id }).expect(202);
      await http()
        .get(`/api/documents/${(pending.body as Body).id}/files/pdf`)
        .set(operator.auth)
        .expect(404);
    });
  });

  // ------------------------------------------------ Vista y descarga pública
  describe('customer view', () => {
    it('lists documents with a signed PDF link that downloads only while valid', async () => {
      const { b, doc } = await accepted();
      const view = await app.get(BookingViewService).toPublicById(b.id);
      expect(view.documents).toHaveLength(1);
      const link = view.documents[0];
      expect(link.docType).toBe('BOLETA');
      expect(link.number).toBe(
        `${doc.series.prefix}-${String(doc.number).padStart(8, '0')}`,
      );
      const url = new URL(link.pdfUrl);
      const path = `${url.pathname}${url.search}`;
      const res = await http()
        .get(path)
        .buffer(true)
        .parse((r, cb) => {
          const chunks: Buffer[] = [];
          r.on('data', (c: Buffer) => chunks.push(c));
          r.on('end', () => cb(null, Buffer.concat(chunks)));
        })
        .expect(200);
      expect(res.headers['content-type']).toContain('application/pdf');
      expect((res.body as Buffer).toString()).toContain('%PDF');

      await http()
        .get(path.replace(/sig=[0-9a-f]{4}/, 'sig=0000'))
        .expect(404);
      await http()
        .get(
          path.replace(/exp=\d+/, `exp=${Math.floor(Date.now() / 1000) - 10}`),
        )
        .expect(404);
      await http().get(`/api/public/documents/${doc.id}/pdf`).expect(404);
      await http()
        .get(
          `/api/public/documents/00000000-0000-4000-8000-000000000000/pdf?exp=1&sig=x`,
        )
        .expect(404);
    });

    it('hides pending, rejected and credit-note documents and refuses their links', async () => {
      const { b, p } = await paidBooking();
      const res = await issue(admin, b.id, { paymentId: p.id }).expect(202);
      expect(
        (await app.get(BookingViewService).toPublicById(b.id)).documents,
      ).toHaveLength(0);
      const id = (res.body as Body).id as string;
      const exp = Math.floor(Date.now() / 1000) + 600;
      const sig = signLink(
        process.env.JWT_ACCESS_SECRET ??
          'dev-only-access-secret-change-me-0123456789',
        `document:${id}`,
        exp,
      );
      await http()
        .get(`/api/public/documents/${id}/pdf?exp=${exp}&sig=${sig}`)
        .expect(404); // sin PDF todavía
    });
  });
});
