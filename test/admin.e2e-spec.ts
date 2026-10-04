import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { ExpiryService } from '../src/modules/bookings/expiry.service';
import { BlockedIdentitiesService } from '../src/modules/admin/blocked-identities.service';
import { HoldsService } from '../src/modules/bookings/holds.service';
import { LogMailer } from '../src/modules/notifications/log-mailer';
import { MAILER } from '../src/modules/notifications/mailer';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  billingBoleta,
  CatalogFixture,
  createCatalog,
  customerInput,
  inHours,
  publishLegal,
  rand,
} from './fixtures';
import { createTestApp, loginAs, TestSession } from './helpers';

type Body = Record<string, any>;
const letters = 'abcdefghijklmnopqrstuvwxyz';
const pick = () => letters[Math.floor(Math.random() * 26)];
const LOCALE = `q${pick()}-${pick()}${pick()}`.replace(
  /-(..)/,
  (_m, x: string) => `-${x.toUpperCase()}`,
);

describe('Administración (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let mailer: LogMailer;
  let admin: TestSession;
  let operator: TestSession;
  let legalIds: string[];
  let fx: CatalogFixture;
  const http = () => request(app.getHttpServer());
  void ExpiryService;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    mailer = app.get<LogMailer>(MAILER);
    admin = await loginAs(app, 'admin');
    operator = await loginAs(app, 'operator');
    legalIds = await publishLegal(app, admin, LOCALE);
    fx = await createCatalog(app);
  });
  afterAll(async () => {
    await app.close();
  });

  async function webBooking(departureId: string, over: Body = {}) {
    const seats = (over.adults ?? 2) + (over.children ?? 0);
    const h = await http()
      .post('/api/public/holds')
      .send({ departureId, seats })
      .expect(201);
    const res = await http()
      .post('/api/public/bookings')
      .send({
        holdToken: (h.body as Body).token,
        currency: 'USD',
        adults: 2,
        customer: customerInput({ locale: LOCALE }),
        billing: billingBoleta,
        paymentKind: 'FULL',
        acceptedLegalDocumentIds: legalIds,
        locale: LOCALE,
        ...over,
      })
      .expect(201);
    const body = res.body as Body;
    const row = await prisma.booking.findUniqueOrThrow({
      where: { reference: body.booking.reference },
    });
    return {
      id: row.id,
      reference: body.booking.reference as string,
      token: body.accessToken as string,
      customerId: row.customerId,
    };
  }

  const pay = (id: string, amountCents: number, over: Body = {}) =>
    http()
      .post(`/api/bookings/${id}/payments/manual`)
      .set(operator.auth)
      .send({
        method: 'CASH',
        kind: 'FULL',
        amountCents,
        currency: 'USD',
        ...over,
      })
      .expect(201);

  // ---------------------------------------------------------------- Empresa
  describe('company and series', () => {
    const company = (over: Body = {}) => ({
      ruc: '20131312955',
      legalName: 'Desértica Tours S.A.C.',
      tradeName: 'Desértica',
      fiscalAddress: 'Av. Los Médanos 100, Ica',
      ubigeo: '110101',
      ...over,
    });

    it('creates the company, updates it in place and keeps the optional fields it was not sent', async () => {
      const created = await http()
        .put('/api/companies/current')
        .set(admin.auth)
        .send(company({ igvRate: '0.1800', environment: 'BETA' }))
        .expect(200);
      const first = created.body as Body;
      expect(first).toMatchObject({
        ruc: '20131312955',
        legalName: 'Desértica Tours S.A.C.',
        igvRate: '0.1800',
        environment: 'BETA',
      });

      const updated = await http()
        .put('/api/companies/current')
        .set(admin.auth)
        .send(
          company({ legalName: 'Desértica Tours SAC', tradeName: undefined }),
        )
        .expect(200);
      expect(updated.body as Body).toMatchObject({
        id: first.id,
        legalName: 'Desértica Tours SAC',
        igvRate: '0.1800',
        environment: 'BETA',
      });
      expect(updated.body as Body).not.toHaveProperty('tradeName');
      const got = await http()
        .get('/api/companies/current')
        .set(admin.auth)
        .expect(200);
      expect((got.body as Body).id).toBe(first.id);
      expect(
        await prisma.auditLog.count({
          where: { entityId: first.id, entity: 'Company' },
        }),
      ).toBeGreaterThan(0);
    });

    it('validates the RUC, the IGV rate and the production check digit', async () => {
      const put = (body: Body) =>
        http().put('/api/companies/current').set(admin.auth).send(body);
      await put(company({ ruc: '123' })).expect(422);
      await put(company({ ruc: '30131312955' })).expect(422); // prefijo inválido
      await put(company({ igvRate: '1.5' })).expect(422);
      await put(company({ ubigeo: '12' })).expect(422);
      await put({ ruc: '20131312955' }).expect(422);
      await put(
        company({ ruc: '20131312954', environment: 'PRODUCTION' }),
      ).expect(422);
      // En BETA un RUC de prueba con dígito distinto sí vale; se deja el original.
      await put(company({ ruc: '20131312955' })).expect(200);
    });

    it('is limited to company:read/write', async () => {
      await http().get('/api/companies/current').set(operator.auth).expect(403);
      await http()
        .put('/api/companies/current')
        .set(operator.auth)
        .send(company())
        .expect(403);
      await http().get('/api/series').set(operator.auth).expect(403);
      await http().get('/api/companies/current').expect(401);
    });

    it('creates series, lists them and rejects duplicates and bad prefixes', async () => {
      await http()
        .put('/api/companies/current')
        .set(admin.auth)
        .send(company())
        .expect(200);
      const prefix = `F${rand()
        .slice(0, 3)
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, 'X')}`;
      const created = await http()
        .post('/api/series')
        .set(admin.auth)
        .send({ docType: 'FACTURA', prefix, nextNumber: 25 })
        .expect(201);
      expect(created.body as Body).toMatchObject({
        docType: 'FACTURA',
        prefix,
        nextNumber: 25,
        active: true,
      });
      await http()
        .post('/api/series')
        .set(admin.auth)
        .send({ docType: 'FACTURA', prefix })
        .expect(409);
      for (const bad of [
        { docType: 'FACTURA', prefix: 'X001' },
        { docType: 'FACTURA', prefix: 'f001' },
        { docType: 'FACTURA', prefix: 'F0010' },
        { docType: 'TICKET', prefix: 'F001' },
        { docType: 'FACTURA', prefix: 'F001', nextNumber: 0 },
        { docType: 'FACTURA', prefix: 'F001', extra: 1 },
      ]) {
        await http().post('/api/series').set(admin.auth).send(bad).expect(422);
      }
      const list = await http().get('/api/series').set(admin.auth).expect(200);
      const found = (list.body as { data: Body[] }).data.find(
        (s) => s.prefix === prefix,
      );
      expect(found).toMatchObject({ nextNumber: 25 });
      await http()
        .post('/api/series')
        .set(admin.auth)
        .send({ docType: 'BOLETA', prefix: `B${prefix.slice(1)}` })
        .expect(201)
        .then((r) => expect((r.body as Body).nextNumber).toBe(1));
    });
  });

  // ------------------------------------------------------------ Bloqueos
  describe('blocked identities', () => {
    it('blocks an email, applies it to bookings and complaints, and lifts it', async () => {
      const dep = await fx.departure();
      const email = `Bloqueado-${rand()}@Example.com`;
      const created = await http()
        .post('/api/blocked-identities')
        .set(admin.auth)
        .send({ kind: 'EMAIL', value: ` ${email} `, reason: 'Fraude' })
        .expect(201);
      const block = created.body as Body;
      expect(block).toMatchObject({
        kind: 'EMAIL',
        value: email.toLowerCase(),
        reason: 'Fraude',
      });
      await http()
        .post('/api/blocked-identities')
        .set(admin.auth)
        .send({ kind: 'EMAIL', value: email.toUpperCase() })
        .expect(409);

      const h = await http()
        .post('/api/public/holds')
        .send({ departureId: dep.id, seats: 2 })
        .expect(201);
      const attempt = (holdToken: string) =>
        http()
          .post('/api/public/bookings')
          .send({
            holdToken,
            currency: 'USD',
            adults: 2,
            customer: customerInput({ email, locale: LOCALE }),
            billing: billingBoleta,
            paymentKind: 'FULL',
            acceptedLegalDocumentIds: legalIds,
            locale: LOCALE,
          });
      const denied = await attempt((h.body as Body).token).expect(403);
      expect(JSON.stringify(denied.body)).not.toMatch(/block/i);
      // El bloqueo se aplica antes de consumir el cupo: el bloqueo de cupo sigue libre.
      expect(
        (
          await prisma.hold.findUniqueOrThrow({
            where: { token: (h.body as Body).token },
          })
        ).releasedAt,
      ).toBeNull();

      const complaint = {
        kind: 'RECLAMO',
        goodType: 'SERVICE',
        consumerName: 'Rosa',
        idDocType: 'DNI',
        idDocNumber: '87654321',
        address: 'Ica',
        email,
        description: 'd',
        detail: 'd',
        request: 'r',
      };
      await http().post('/api/public/complaints').send(complaint).expect(403);

      await http()
        .delete(`/api/blocked-identities/${block.id}`)
        .set(admin.auth)
        .expect(204);
      await http()
        .delete(`/api/blocked-identities/${block.id}`)
        .set(admin.auth)
        .expect(404);
      await attempt((h.body as Body).token).expect(201);
      await http().post('/api/public/complaints').send(complaint).expect(201);

      // La auditoría no guarda el correo.
      const logs = await prisma.auditLog.findMany({
        where: { entity: 'BlockedIdentity', entityId: block.id },
      });
      expect(logs.map((l) => l.action).sort()).toEqual([
        'blockedIdentity.create',
        'blockedIdentity.delete',
      ]);
      expect(JSON.stringify(logs)).not.toContain(email.toLowerCase());
    });

    it('canonicalizes IPs and refuses seat holds and bookings from a blocked address', async () => {
      const ip = `203.0.113.${1 + Math.floor(Math.random() * 250)}`;
      const created = await http()
        .post('/api/blocked-identities')
        .set(admin.auth)
        .send({ kind: 'IP', value: `::FFFF:${ip}` })
        .expect(201);
      expect((created.body as Body).value).toBe(ip);
      try {
        const dep = await fx.departure();
        await expect(
          app.get(HoldsService).create(dep.id, 1, { ip: `::ffff:${ip}` }),
        ).rejects.toMatchObject({ status: 403 });
        await expect(
          app
            .get(BlockedIdentitiesService)
            .assertAllowed({ ip: '203.0.113.255' }),
        ).resolves.toBeUndefined();
        // Sin IP legible no se bloquea nada.
        await expect(
          app.get(BlockedIdentitiesService).assertAllowed({ ip: undefined }),
        ).resolves.toBeUndefined();
      } finally {
        await http()
          .delete(`/api/blocked-identities/${(created.body as Body).id}`)
          .set(admin.auth)
          .expect(204);
      }
    });

    it('validates the value, lists, and needs fraud permissions', async () => {
      for (const bad of [
        { kind: 'EMAIL', value: 'not-an-email' },
        { kind: 'IP', value: '999.1.1.1' },
        { kind: 'IP', value: 'hello' },
        { kind: 'PHONE', value: '1' },
        { kind: 'EMAIL' },
      ]) {
        await http()
          .post('/api/blocked-identities')
          .set(admin.auth)
          .send(bad)
          .expect(422);
      }
      const list = await http()
        .get('/api/blocked-identities')
        .set(admin.auth)
        .expect(200);
      expect(Array.isArray((list.body as Body).data)).toBe(true);
      await http()
        .get('/api/blocked-identities')
        .set(operator.auth)
        .expect(403);
      await http()
        .post('/api/blocked-identities')
        .set(operator.auth)
        .send({ kind: 'EMAIL', value: 'a@b.co' })
        .expect(403);
      await http()
        .delete('/api/blocked-identities/00000000-0000-4000-8000-000000000000')
        .set(operator.auth)
        .expect(403);
    });
  });

  // -------------------------------------------------------------- Reportes
  describe('dashboard and sales report', () => {
    // Un día de Lima propio de esta corrida, lejos de los datos de las demás pruebas.
    const year = 2001 + Math.floor(Math.random() * 12);
    const day = `${year}-0${1 + Math.floor(Math.random() * 9)}-1${Math.floor(Math.random() * 10)}`;
    const noon = `${day}T17:00:00Z`; // 12:00 en Lima

    it('adds what was collected and refunded, by day, tour and provider', async () => {
      const dep = await fx.departure();
      const b1 = await webBooking(dep.id);
      const b2 = await webBooking(dep.id, { currency: 'PEN' });
      await pay(b1.id, 20000, { paidAt: noon });
      await pay(b1.id, 1, {
        paidAt: noon,
        method: 'YAPE',
        reference: `OP-${rand()}`,
      }).catch(() => undefined);
      await pay(b2.id, 72000, { currency: 'PEN', paidAt: `${day}T04:59:00Z` }); // 23:59 del día anterior en Lima

      const sales = async (groupBy: string, from = day, to = day) =>
        (
          (
            await http()
              .get('/api/reports/sales')
              .query({ from, to, groupBy })
              .set(operator.auth)
              .expect(200)
          ).body as { data: Body[] }
        ).data;

      expect(await sales('day')).toEqual([
        {
          key: day,
          currency: 'USD',
          grossCents: expect.any(Number),
          refundedCents: 0,
          bookings: 1,
        },
      ]);
      const prev = new Date(Date.parse(`${day}T00:00:00Z`) - 86_400_000)
        .toISOString()
        .slice(0, 10);
      expect(await sales('day', prev, prev)).toEqual([
        {
          key: prev,
          currency: 'PEN',
          grossCents: 72000,
          refundedCents: 0,
          bookings: 1,
        },
      ]);
      const wide = await sales('provider', prev, day);
      expect(wide.map((r) => `${r.key}/${r.currency}`).sort()).toEqual([
        'MANUAL/PEN',
        'MANUAL/USD',
      ]);
      const byTour = (await sales('tour', prev, day)).filter(
        (r) => r.key === fx.tour.slug,
      );
      expect(byTour).toHaveLength(2);

      const dash = await http()
        .get('/api/dashboard/summary')
        .query({ from: prev, to: day })
        .set(operator.auth)
        .expect(200);
      expect((dash.body as Body).sales).toEqual([
        { currency: 'PEN', grossCents: 72000, refundedCents: 0, bookings: 1 },
        {
          currency: 'USD',
          grossCents: expect.any(Number),
          refundedCents: 0,
          bookings: 1,
        },
      ]);
    });

    it('counts a successful refund by its date and keeps the occupancy and pending figures', async () => {
      const dep = await fx.departure({ capacity: 6 });
      const { id } = await webBooking(dep.id);
      await pay(id, 20000);
      const payment = await prisma.payment.findFirstOrThrow({
        where: { bookingId: id },
      });
      await prisma.refund.create({
        data: {
          paymentId: payment.id,
          amountCents: 5000,
          reason: 'test',
          status: 'SUCCEEDED',
        },
      });
      const today = new Date().toISOString().slice(0, 10);
      const tomorrow = new Date(Date.now() + 86_400_000)
        .toISOString()
        .slice(0, 10);
      const rows = (
        (
          await http()
            .get('/api/reports/sales')
            .query({ from: today, to: tomorrow, groupBy: 'tour' })
            .set(admin.auth)
            .expect(200)
        ).body as { data: Body[] }
      ).data;
      expect(rows.find((r) => r.key === fx.tour.slug)).toMatchObject({
        grossCents: 20000,
        refundedCents: 5000,
        bookings: 1,
      });

      const start = dep.startsAt.toISOString().slice(0, 10);
      const dash = (
        await http()
          .get('/api/dashboard/summary')
          .query({ from: start, to: start })
          .set(admin.auth)
          .expect(200)
      ).body as Body;
      expect(dash.occupancy.seatsSold).toBeGreaterThanOrEqual(2);
      expect(dash.occupancy.seatsCapacity).toBeGreaterThanOrEqual(6);
      expect(dash.pending).toMatchObject({
        unpaidBookings: expect.any(Number),
        documentsInError: expect.any(Number),
        waiversPending: expect.any(Number),
        openDisputes: expect.any(Number),
        complaintsDueSoon: expect.any(Number),
      });
      expect(dash.pending.waiversPending).toBeGreaterThanOrEqual(2);
    });

    it('exports CSV and defuses spreadsheet formulas', async () => {
      const dep = await fx.departure();
      const { id } = await webBooking(dep.id);
      await pay(id, 20000, { paidAt: noon });
      const evil = `=HYPERLINK("http://x")${rand()}`;
      await prisma.tourRef.update({
        where: { id: fx.tour.id },
        data: { slug: evil },
      });
      try {
        const res = await http()
          .get('/api/reports/sales')
          .query({ from: day, to: day, groupBy: 'tour', format: 'csv' })
          .set(admin.auth)
          .expect(200);
        expect(res.headers['content-type']).toMatch(/text\/csv/);
        expect(res.headers['content-disposition']).toMatch(/attachment/);
        const lines = res.text.trim().split('\r\n');
        expect(lines[0]).toBe('key,currency,grossCents,refundedCents,bookings');
        const cell = lines.find((l) => l.includes('HYPERLINK'))!;
        expect(cell.startsWith(`"'=HYPERLINK(""http://x"")`)).toBe(true);
      } finally {
        await prisma.tourRef.update({
          where: { id: fx.tour.id },
          data: { slug: fx.tour.slug },
        });
      }
    });

    it('validates the range and the permission', async () => {
      const q = (query: Body, who = admin) =>
        http().get('/api/reports/sales').query(query).set(who.auth);
      await q({ from: '2026-02-10', to: '2026-02-01' }).expect(422);
      await q({ from: '2026-02-30', to: '2026-03-01' }).expect(422);
      await q({ from: '2025-01-01', to: '2026-03-01' }).expect(422);
      await q({ from: 'x', to: '2026-03-01' }).expect(422);
      await q({ from: '2026-01-01' }).expect(422);
      await q({
        from: '2026-01-01',
        to: '2026-01-02',
        groupBy: 'month',
      }).expect(422);
      await q({ from: '2026-01-01', to: '2026-01-02', format: 'xml' }).expect(
        422,
      );
      await http()
        .get('/api/dashboard/summary')
        .query({ from: '2026-03-01', to: '2026-02-01' })
        .set(admin.auth)
        .expect(422);
      await http()
        .get('/api/dashboard/summary')
        .query({ from: '2026-03-01', to: '2026-03-02' })
        .expect(401);
    });
  });

  // ------------------------------------------------------ Mensajes de contacto
  describe('contact messages', () => {
    it('lists, filters and marks messages as handled', async () => {
      const email = `contacto-${rand()}@example.com`;
      await http()
        .post('/api/public/contact-messages')
        .send({ name: 'Marta', email, message: '¿Hay cupo?', locale: 'es' })
        .expect(202);
      const row = await prisma.contactMessage.findFirstOrThrow({
        where: { email },
      });
      const list = (handled?: boolean) =>
        http()
          .get('/api/contact-messages')
          .query({
            pageSize: 100,
            ...(handled === undefined ? {} : { handled }),
          })
          .set(operator.auth)
          .expect(200)
          .then((r) => (r.body as { data: Body[] }).data.map((m) => m.id));
      expect(await list(false)).toContain(row.id);
      expect(await list()).toContain(row.id);

      const done = await http()
        .patch(`/api/contact-messages/${row.id}`)
        .set(operator.auth)
        .send({ handled: true })
        .expect(200);
      expect(done.body as Body).toMatchObject({
        id: row.id,
        email,
        message: '¿Hay cupo?',
        handled: true,
      });
      expect(done.body as Body).not.toHaveProperty('ip');
      expect(await list(false)).not.toContain(row.id);
      expect(await list(true)).toContain(row.id);
      await http()
        .patch(`/api/contact-messages/${row.id}`)
        .set(operator.auth)
        .send({ handled: false })
        .expect(200);
      expect(await list(false)).toContain(row.id);

      await http()
        .patch('/api/contact-messages/00000000-0000-4000-8000-000000000000')
        .set(operator.auth)
        .send({ handled: true })
        .expect(404);
      await http()
        .patch(`/api/contact-messages/${row.id}`)
        .set(operator.auth)
        .send({ handled: 'yes' })
        .expect(422);
      await http()
        .get('/api/contact-messages')
        .query({ handled: 'maybe' })
        .set(operator.auth)
        .expect(422);
      await http().get('/api/contact-messages').expect(401);
    });
  });

  // ------------------------------------------------------------------ ARCO
  describe('customer erasure (ARCO)', () => {
    async function paidAndCancelledBooking() {
      const dep = await fx.departure({ startsAt: inHours(3) });
      const email = `arco-${rand()}@example.com`;
      const b = await webBooking(dep.id, {
        customer: customerInput({
          email,
          firstName: 'Zoila',
          lastName: 'Ramírez',
          idDocNumber: '45454545',
          locale: LOCALE,
        }),
        passengers: [
          {
            firstName: 'Zoila',
            lastName: 'Ramírez',
            idDocType: 'DNI',
            idDocNumber: '45454545',
            emergencyContactName: 'Pedro',
            emergencyContactPhone: '999',
          },
        ],
        notes: 'Alérgica a los frutos secos',
        anonymousId: `anon_${rand()}${rand()}`,
      });
      await pay(b.id, 20000);
      return { ...b, email, dep };
    }

    it('refuses while there are upcoming bookings or pending refunds, then anonymizes', async () => {
      const b = await paidAndCancelledBooking();
      const erase = (id = b.customerId, who = admin) =>
        http().post(`/api/customers/${id}/erase`).set(who.auth);
      await erase().expect(409); // reserva vigente

      await http()
        .post(`/api/bookings/${b.id}/cancel`)
        .set(admin.auth)
        .send({ reason: 'Cliente alérgico, enfermo', refund: 'FULL' })
        .expect(200);
      const refunds = await prisma.refund.findMany({
        where: { payment: { bookingId: b.id } },
      });
      expect(refunds).toHaveLength(1);
      await erase().expect(409); // reembolso pendiente
      await prisma.refund.updateMany({
        where: { payment: { bookingId: b.id } },
        data: { status: 'SUCCEEDED' },
      });

      // Datos que deben desaparecer o conservarse.
      const company = await prisma.company.findFirstOrThrow();
      const series = await prisma.series.findFirstOrThrow({
        where: { companyId: company.id },
      });
      const payment = await prisma.payment.findFirstOrThrow({
        where: { bookingId: b.id },
      });
      await prisma.payment.update({
        where: { id: payment.id },
        data: { providerPayload: { holder: 'Zoila Ramírez' } },
      });
      const doc = await prisma.document.create({
        data: {
          bookingId: b.id,
          paymentId: payment.id,
          seriesId: series.id,
          number: Math.floor(Math.random() * 1_000_000_000),
          docType: 'BOLETA',
          currency: 'USD',
          totalCents: 20000,
          taxableCents: 16949,
          igvCents: 3051,
          customerSnapshot: { name: 'Zoila Ramírez', idDocNumber: '45454545' },
        },
      });
      await http()
        .post('/api/public/contact-messages')
        .send({ name: 'Zoila', email: b.email, message: 'Hola' })
        .expect(202);
      const complaint = await http()
        .post('/api/public/complaints')
        .send({
          kind: 'QUEJA',
          goodType: 'SERVICE',
          consumerName: 'Zoila Ramírez',
          idDocType: 'DNI',
          idDocNumber: '45454545',
          address: 'Ica',
          email: b.email,
          description: 'd',
          detail: 'd',
          request: 'r',
        })
        .expect(201);
      await http()
        .get(`/api/public/bookings/${b.reference}`)
        .set('X-Booking-Token', b.token)
        .expect(200);

      await erase().expect(204);

      const customer = await prisma.customer.findUniqueOrThrow({
        where: { id: b.customerId },
      });
      expect(customer).toMatchObject({
        email: `erased-${b.customerId}@erased.invalid`,
        firstName: 'Anonimizado',
        lastName: 'Anonimizado',
        phone: null,
        country: null,
        idDocType: null,
        idDocNumber: null,
      });
      expect(customer.erasedAt).not.toBeNull();
      const passenger = await prisma.passenger.findFirstOrThrow({
        where: { bookingId: b.id },
      });
      expect(passenger).toMatchObject({
        firstName: 'Anonimizado',
        idDocNumber: null,
        emergencyContactName: null,
        emergencyContactPhone: null,
      });
      const booking = await prisma.booking.findUniqueOrThrow({
        where: { id: b.id },
      });
      expect(booking).toMatchObject({
        notes: null,
        cancelReason: null,
        anonymousId: null,
      });
      expect(booking.billing).toEqual(billingBoleta); // hay comprobante: se conserva el receptor
      expect(
        (await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } }))
          .providerPayload,
      ).toBeNull();
      expect(
        (
          await prisma.refund.findFirstOrThrow({
            where: { paymentId: payment.id },
          })
        ).reason,
      ).toBe('erased');
      expect(
        (await prisma.document.findUniqueOrThrow({ where: { id: doc.id } }))
          .customerSnapshot,
      ).toEqual({ name: 'Zoila Ramírez', idDocNumber: '45454545' });
      expect(
        await prisma.complaint.count({
          where: { id: (complaint.body as Body).correlative },
        }),
      ).toBe(1);
      expect(
        await prisma.contactMessage.count({ where: { email: b.email } }),
      ).toBe(0);
      expect(
        await prisma.notification.count({ where: { toAddress: b.email } }),
      ).toBe(0);
      expect(
        await prisma.bookingAccessToken.count({ where: { bookingId: b.id } }),
      ).toBe(0);
      await http()
        .get(`/api/public/bookings/${b.reference}`)
        .set('X-Booking-Token', b.token)
        .expect(401);

      // La auditoría recibe conteos y nada personal, ni antes ni después.
      const logs = JSON.stringify(
        await prisma.auditLog.findMany({
          where: { OR: [{ entityId: b.id }, { entityId: b.customerId }] },
        }),
      );
      expect(logs).not.toContain(b.email);
      expect(logs).not.toContain('Zoila');
      expect(logs).not.toContain('frutos');
      expect(logs).not.toContain('45454545');
      expect(
        (
          await prisma.auditLog.findFirstOrThrow({
            where: { entityId: b.customerId, action: 'customer.erase' },
          })
        ).after,
      ).toEqual({ bookings: 1, passengers: 1 });

      // Idempotente y sin segunda entrada de auditoría.
      await erase().expect(204);
      expect(
        await prisma.auditLog.count({
          where: { entityId: b.customerId, action: 'customer.erase' },
        }),
      ).toBe(1);
    });

    it('erases the stored response of an idempotent manual booking', async () => {
      const dep = await fx.departure();
      const email = `manual-${rand()}@example.com`;
      const key = `key-${rand()}-${rand()}`;
      const res = await http()
        .post('/api/bookings')
        .set(operator.auth)
        .set('Idempotency-Key', key)
        .send({
          departureId: dep.id,
          currency: 'USD',
          adults: 1,
          customer: customerInput({ email }),
          billing: billingBoleta,
          sendConfirmation: false,
        })
        .expect(201);
      const id = (res.body as Body).id as string;
      const customerId = (res.body as Body).customer.id as string;
      expect(await prisma.idempotencyRecord.count({ where: { key } })).toBe(1);
      await http()
        .post(`/api/bookings/${id}/cancel`)
        .set(admin.auth)
        .send({ reason: 'x', refund: 'POLICY' })
        .expect(200);
      await http()
        .post(`/api/customers/${customerId}/erase`)
        .set(admin.auth)
        .expect(204);
      expect(await prisma.idempotencyRecord.count({ where: { key } })).toBe(0);
      // Una reserva nueva con el mismo correo crea un cliente nuevo.
      const again = await http()
        .post('/api/bookings')
        .set(operator.auth)
        .send({
          departureId: dep.id,
          currency: 'USD',
          adults: 1,
          customer: customerInput({ email }),
          billing: billingBoleta,
          sendConfirmation: false,
        })
        .expect(201);
      expect((again.body as Body).customer.id).not.toBe(customerId);
    });

    it('answers 404, needs customers:erase and an unknown id is not leaked', async () => {
      await http()
        .post('/api/customers/00000000-0000-4000-8000-000000000000/erase')
        .set(admin.auth)
        .expect(404);
      await http()
        .post('/api/customers/00000000-0000-4000-8000-000000000000/erase')
        .set(operator.auth)
        .expect(403);
      await http()
        .post('/api/customers/not-a-uuid/erase')
        .set(admin.auth)
        .expect(422);
    });
  });

  // ------------------------------------------------------ Cancelar una salida
  describe('departure cancellation', () => {
    const cancel = (id: string, body: Body, who = admin) =>
      http().post(`/api/departures/${id}/cancel`).set(who.auth).send(body);

    it('REFUND cancels every active booking, queues full refunds, releases holds and notifies', async () => {
      const dep = await fx.departure({ capacity: 10 });
      const paid = await webBooking(dep.id);
      await pay(paid.id, 20000);
      const unpaid = await webBooking(dep.id, { adults: 1 });
      const free = await http()
        .post('/api/public/holds')
        .send({ departureId: dep.id, seats: 3 })
        .expect(201);
      const mails = mailer.sent.length;

      const res = await cancel(dep.id, {
        reason: 'Mar picado',
        resolution: 'REFUND',
      }).expect(202);
      expect(res.body).toEqual({ affectedBookings: 2 });

      expect(
        (await prisma.departure.findUniqueOrThrow({ where: { id: dep.id } }))
          .status,
      ).toBe('CANCELLED');
      for (const b of [paid, unpaid]) {
        const row = await prisma.booking.findUniqueOrThrow({
          where: { id: b.id },
        });
        expect(row).toMatchObject({
          status: 'CANCELLED',
          cancelReason: 'Mar picado',
        });
        expect(row.cancelledAt).not.toBeNull();
      }
      const refunds = await prisma.refund.findMany({
        where: { payment: { bookingId: paid.id } },
      });
      expect(refunds.map((r) => [r.status, r.amountCents])).toEqual([
        ['PENDING', 20000],
      ]);
      expect(refunds[0].policyTier).toMatchObject({
        mode: 'DEPARTURE_CANCELLED',
      });
      expect(
        await prisma.refund.count({
          where: { payment: { bookingId: unpaid.id } },
        }),
      ).toBe(0);
      expect(
        (
          await prisma.hold.findUniqueOrThrow({
            where: { token: (free.body as Body).token },
          })
        ).releasedAt,
      ).not.toBeNull();
      const sent = mailer.sent
        .slice(mails)
        .filter((m) => m.template === 'booking_cancelled');
      expect(sent).toHaveLength(2);
      expect(
        sent.find((m) => (m.data as Body).reference === paid.reference)!.data,
      ).toMatchObject({ refundDueCents: 20000 });
      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { entityId: dep.id, action: 'departure.cancel' },
      });
      expect(audit.after).toMatchObject({
        resolution: 'REFUND',
        affectedBookings: 2,
      });

      // No se repite ni admite más ventas.
      await cancel(dep.id, { reason: 'x', resolution: 'REFUND' }).expect(409);
      await http()
        .post('/api/public/holds')
        .send({ departureId: dep.id, seats: 1 })
        .expect(409);
      // La reserva pagada ya no se puede cancelar de nuevo.
      await http()
        .post(`/api/bookings/${paid.id}/cancel`)
        .set(admin.auth)
        .send({ reason: 'x', refund: 'POLICY' })
        .expect(409);
    });

    it('RESCHEDULE moves the bookings keeping their price, and refuses without room', async () => {
      const dep = await fx.departure({ capacity: 10 });
      const target = await fx.departure({ capacity: 10 });
      const tight = await fx.departure({ capacity: 3 });
      const a = await webBooking(dep.id);
      const b = await webBooking(dep.id, { adults: 1, children: 1 });
      await pay(a.id, 20000);
      const before = await prisma.booking.findMany({
        where: { id: { in: [a.id, b.id] } },
        orderBy: { id: 'asc' },
      });

      await cancel(dep.id, {
        reason: 'x',
        resolution: 'RESCHEDULE',
        targetDepartureId: tight.id,
      }).expect(409); // 4 asientos en una salida con 3
      expect(
        (await prisma.departure.findUniqueOrThrow({ where: { id: dep.id } }))
          .status,
      ).toBe('OPEN');

      const mails = mailer.sent.length;
      const res = await cancel(dep.id, {
        reason: 'Clima',
        resolution: 'RESCHEDULE',
        targetDepartureId: target.id,
      }).expect(202);
      expect(res.body).toEqual({ affectedBookings: 2 });
      const after = await prisma.booking.findMany({
        where: { id: { in: [a.id, b.id] } },
        orderBy: { id: 'asc' },
      });
      for (const [i, row] of after.entries()) {
        expect(row.departureId).toBe(target.id);
        expect(row.status).toBe(before[i].status);
        expect(row.totalCents).toBe(before[i].totalCents);
        expect(row.paidCents).toBe(before[i].paidCents);
        expect((row.priceSnapshot as Body).rescheduled.at(-1)).toMatchObject({
          fromDepartureId: dep.id,
          cause: 'DEPARTURE_CANCELLED',
        });
      }
      expect(
        await prisma.refund.count({ where: { payment: { bookingId: a.id } } }),
      ).toBe(0);
      expect(
        mailer.sent
          .slice(mails)
          .filter((m) => m.template === 'booking_rescheduled'),
      ).toHaveLength(2);
    });

    it('CLIENT_CHOICE closes the departure, leaves the bookings and notifies', async () => {
      const dep = await fx.departure();
      const a = await webBooking(dep.id);
      await pay(a.id, 20000);
      const mails = mailer.sent.length;
      const res = await cancel(dep.id, {
        reason: 'Sin guía',
        resolution: 'CLIENT_CHOICE',
      }).expect(202);
      expect(res.body).toEqual({ affectedBookings: 1 });
      expect(
        (await prisma.booking.findUniqueOrThrow({ where: { id: a.id } }))
          .status,
      ).toBe('CONFIRMED');
      expect(
        mailer.sent
          .slice(mails)
          .some(
            (m) =>
              m.template === 'departure_cancelled' &&
              (m.data as Body).reference === a.reference,
          ),
      ).toBe(true);
      // El staff las resuelve después: reprogramar fuera de la salida cancelada.
      const target = await fx.departure();
      await http()
        .post(`/api/bookings/${a.id}/reschedule`)
        .set(admin.auth)
        .send({ targetDepartureId: target.id })
        .expect(200);
    });

    it('validates the request, the target and the permission', async () => {
      const dep = await fx.departure();
      const other = await createCatalog(app);
      const foreign = await other.departure();
      const target = await fx.departure();
      await cancel(dep.id, { reason: 'x', resolution: 'RESCHEDULE' }).expect(
        422,
      );
      await cancel(dep.id, {
        reason: 'x',
        resolution: 'REFUND',
        targetDepartureId: target.id,
      }).expect(422);
      await cancel(dep.id, {
        reason: 'x',
        resolution: 'RESCHEDULE',
        targetDepartureId: dep.id,
      }).expect(422);
      await cancel(dep.id, {
        reason: 'x',
        resolution: 'RESCHEDULE',
        targetDepartureId: foreign.id,
      }).expect(422);
      await cancel(dep.id, {
        reason: 'x',
        resolution: 'RESCHEDULE',
        targetDepartureId: '00000000-0000-4000-8000-000000000000',
      }).expect(422);
      await cancel(dep.id, { resolution: 'REFUND' }).expect(422);
      await cancel(dep.id, { reason: 'x', resolution: 'DELETE' }).expect(422);
      await cancel(
        dep.id,
        { reason: 'x', resolution: 'REFUND' },
        operator,
      ).expect(403);
      await cancel('00000000-0000-4000-8000-000000000000', {
        reason: 'x',
        resolution: 'REFUND',
      }).expect(404);
      expect(
        (await prisma.departure.findUniqueOrThrow({ where: { id: dep.id } }))
          .status,
      ).toBe('OPEN');
    });

    it('does not oversell the target when two cancellations race for it', async () => {
      const a = await fx.departure({ capacity: 10 });
      const b = await fx.departure({ capacity: 10 });
      const target = await fx.departure({ capacity: 5 });
      await webBooking(a.id, { adults: 3 });
      await webBooking(b.id, { adults: 3 });
      const results = await Promise.all([
        cancel(a.id, {
          reason: 'x',
          resolution: 'RESCHEDULE',
          targetDepartureId: target.id,
        }),
        cancel(b.id, {
          reason: 'x',
          resolution: 'RESCHEDULE',
          targetDepartureId: target.id,
        }),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([202, 409]);
    });
  });
});
