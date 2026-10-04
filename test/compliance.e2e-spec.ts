import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { LogMailer } from '../src/modules/notifications/log-mailer';
import { MAILER } from '../src/modules/notifications/mailer';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  billingBoleta,
  createCatalog,
  customerInput,
  publishLegal,
  publishWaiverSnapshot,
  rand,
} from './fixtures';
import { createTestApp, loginAs, TestSession } from './helpers';

type Body = Record<string, any>;
// Los textos legales son inmutables y no se pueden borrar: cada corrida usa idiomas propios.
const letters = 'abcdefghijklmnopqrstuvwxyz';
const pick = () => letters[Math.floor(Math.random() * 26)];
const freshLocale = () =>
  `q${pick()}-${pick()}${pick()}`.replace(
    /-(..)/,
    (_m, x: string) => `-${x.toUpperCase()}`,
  );
const LOCALE = freshLocale();

describe('Cumplimiento (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let mailer: LogMailer;
  let admin: TestSession;
  let operator: TestSession;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    mailer = app.get<LogMailer>(MAILER);
    admin = await loginAs(app, 'admin');
    operator = await loginAs(app, 'operator');
  });
  afterAll(async () => {
    await app.close();
  });

  describe('legal documents', () => {
    it('publishes versions with an immutable snapshot of the CMS text', async () => {
      const first = await http()
        .post('/api/legal-documents')
        .set(admin.auth)
        .send({ kind: 'TERMS', locale: LOCALE, cmsSlug: 'terms' })
        .expect(201);
      const second = await http()
        .post('/api/legal-documents')
        .set(admin.auth)
        .send({ kind: 'TERMS', locale: LOCALE, cmsSlug: 'terms' })
        .expect(201);
      expect((first.body as Body).version).toBe(1);
      expect((second.body as Body).version).toBe(2);
      expect(second.body).toMatchObject({
        kind: 'TERMS',
        locale: LOCALE,
        cmsSlug: 'terms',
        title: 'Título terms',
      });
      expect((second.body as Body).contentHash).toMatch(/^[0-9a-f]{64}$/);

      const row = await prisma.legalDocument.findUniqueOrThrow({
        where: { id: (second.body as Body).id },
      });
      expect(row.textSnapshot).toContain('Texto vigente de terms');
      expect(row.title).toBe('Título terms');

      await expect(
        prisma.legalDocument.update({
          where: { id: row.id },
          data: { textSnapshot: 'cambiado' },
        }),
      ).rejects.toThrow(/insert-only/);
      await expect(
        prisma.legalDocument.delete({ where: { id: row.id } }),
      ).rejects.toThrow();
      expect(
        (
          await prisma.legalDocument.findUniqueOrThrow({
            where: { id: row.id },
          })
        ).textSnapshot,
      ).toBe(row.textSnapshot);
    });

    it('numbers versions correctly under simultaneous publications', async () => {
      const locale = freshLocale();
      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          http()
            .post('/api/legal-documents')
            .set(admin.auth)
            .send({ kind: 'PRIVACY', locale, cmsSlug: 'privacy' }),
        ),
      );
      expect(results.every((r) => r.status === 201)).toBe(true);
      expect(results.map((r) => (r.body as Body).version).sort()).toEqual([
        1, 2, 3, 4, 5,
      ]);
    });

    it('rejects pages the CMS does not have and users without legal:write', async () => {
      await http()
        .post('/api/legal-documents')
        .set(admin.auth)
        .send({ kind: 'TERMS', locale: LOCALE, cmsSlug: 'nope' })
        .expect(422);
      await http()
        .post('/api/legal-documents')
        .set(admin.auth)
        .send({ kind: 'OTHER', locale: LOCALE, cmsSlug: 'terms' })
        .expect(422);
      await http()
        .post('/api/legal-documents')
        .set(operator.auth)
        .send({ kind: 'TERMS', locale: LOCALE, cmsSlug: 'terms' })
        .expect(403);
      await http().post('/api/legal-documents').send({}).expect(401);
    });

    it('serves the current version of each kind in a language', async () => {
      const locale = freshLocale();
      expect(
        (
          (
            await http()
              .get('/api/public/legal-documents/current')
              .query({ locale })
              .expect(200)
          ).body as Body
        ).data,
      ).toEqual([]);
      const ids = await publishLegal(app, admin, locale);
      const newer = await http()
        .post('/api/legal-documents')
        .set(admin.auth)
        .send({ kind: 'TERMS', locale, cmsSlug: 'terms' })
        .expect(201);
      const res = await http()
        .get('/api/public/legal-documents/current')
        .query({ locale })
        .expect(200);
      const data = (res.body as { data: Body[] }).data;
      expect(data).toHaveLength(3);
      expect(data.find((d) => d.kind === 'TERMS')!.id).toBe(
        (newer.body as Body).id,
      );
      expect(data.find((d) => d.kind === 'PRIVACY')!.id).toBe(ids[1]);
      await http().get('/api/public/legal-documents/current').expect(422);
    });
  });

  describe('Libro de Reclamaciones', () => {
    const complaint = (over: Body = {}) => ({
      kind: 'RECLAMO',
      goodType: 'SERVICE',
      consumerName: 'Rosa Huamán',
      idDocType: 'DNI',
      idDocNumber: '87654321',
      address: 'Av. Grau 123, Ica',
      email: `reclamo-${rand()}@example.com`,
      phone: '+51987654321',
      description: 'Tour dune buggy del 10 de octubre',
      detail: 'El buggy llegó 40 minutos tarde y el recorrido fue más corto.',
      request: 'Devolución parcial',
      ...over,
    });

    it('registers a complaint with a correlative and a business-day deadline, and emails a copy', async () => {
      const body = complaint({
        amountCents: 10000,
        currency: 'USD',
        bookingRef: 'DST-ABC123',
      });
      const before = mailer.sent.length;
      const res = await http()
        .post('/api/public/complaints')
        .send(body)
        .expect(201);
      const created = res.body as { correlative: number; dueAt: string };
      expect(created.correlative).toBeGreaterThan(0);

      const due = new Date(created.dueAt);
      const days = (due.getTime() - Date.now()) / 86_400_000;
      expect(days).toBeGreaterThan(14.9);
      expect(days).toBeLessThan(22); // 15 hábiles = 21 corridos como máximo
      expect([0, 6]).not.toContain(
        new Date(due.getTime() - 5 * 3_600_000).getUTCDay(),
      );

      const mail = mailer.sent
        .slice(before)
        .find((m) => m.template === 'complaint_received')!;
      expect(mail.to).toBe(body.email);
      expect((mail.data as Body).correlative).toBe(created.correlative);

      const list = await http()
        .get('/api/complaints')
        .query({ status: 'OPEN', pageSize: 100 })
        .set(operator.auth)
        .expect(200);
      const row = (list.body as { data: Body[] }).data.find(
        (c) => c.id === created.correlative,
      )!;
      expect(row).toMatchObject({
        kind: 'RECLAMO',
        status: 'OPEN',
        consumerName: 'Rosa Huamán',
        amountCents: 10000,
        currency: 'USD',
        answer: null,
      });
    });

    it('gives increasing correlatives and validates the form', async () => {
      const a = await http()
        .post('/api/public/complaints')
        .send(complaint())
        .expect(201);
      const b = await http()
        .post('/api/public/complaints')
        .send(complaint())
        .expect(201);
      expect((b.body as Body).correlative).toBeGreaterThan(
        (a.body as Body).correlative,
      );
      await http()
        .post('/api/public/complaints')
        .send(complaint({ idDocNumber: '123' }))
        .expect(422);
      await http()
        .post('/api/public/complaints')
        .send(complaint({ kind: 'OTRO' }))
        .expect(422);
      await http()
        .post('/api/public/complaints')
        .send(complaint({ detail: '' }))
        .expect(422);
      await http()
        .post('/api/public/complaints')
        .send(complaint({ amountCents: 100 }))
        .expect(422); // sin moneda
      await http()
        .post('/api/public/complaints')
        .send({ ...complaint(), extra: 1 })
        .expect(422);
    });

    it('limits how many complaints one email can file per day', async () => {
      const email = `spam-${rand()}@example.com`;
      for (let i = 0; i < 5; i++)
        await http()
          .post('/api/public/complaints')
          .send(complaint({ email }))
          .expect(201);
      await http()
        .post('/api/public/complaints')
        .send(complaint({ email }))
        .expect(429);
    });

    it('answers a complaint, emails the consumer and audits it', async () => {
      const created = await http()
        .post('/api/public/complaints')
        .send(complaint())
        .expect(201);
      const id = (created.body as Body).correlative as number;
      await http().get(`/api/complaints/${id}`).set(operator.auth).expect(200);
      const before = mailer.sent.length;
      const res = await http()
        .post(`/api/complaints/${id}/answer`)
        .set(operator.auth)
        .send({ answer: 'Le devolvemos el 30 %.' })
        .expect(200);
      expect(res.body).toMatchObject({
        id,
        status: 'ANSWERED',
        answer: 'Le devolvemos el 30 %.',
      });
      expect((res.body as Body).answeredAt).toBeTruthy();
      expect(
        mailer.sent
          .slice(before)
          .some((m) => m.template === 'complaint_answered'),
      ).toBe(true);
      expect(
        await prisma.auditLog.count({
          where: {
            entity: 'Complaint',
            entityId: String(id),
            action: 'complaint.answer',
          },
        }),
      ).toBe(1);

      await http()
        .post(`/api/complaints/${id}/answer`)
        .set(operator.auth)
        .send({ answer: 'Otra respuesta' })
        .expect(409);
      expect(
        (await prisma.complaint.findUniqueOrThrow({ where: { id } })).answer,
      ).toBe('Le devolvemos el 30 %.');
      await http()
        .post(`/api/complaints/${id}/answer`)
        .set(operator.auth)
        .send({})
        .expect(422);
      await http()
        .post('/api/complaints/999999999/answer')
        .set(operator.auth)
        .send({ answer: 'x' })
        .expect(404);
      await http().get('/api/complaints/abc').set(operator.auth).expect(422);
      await http().get(`/api/complaints/${id}`).expect(401);
    });
  });

  describe('waivers', () => {
    it('shows and signs a waiver once, saving the emergency contact', async () => {
      const fx = await createCatalog(app);
      await prisma.tourRef.update({
        where: { id: fx.tour.id },
        data: { minAge: 12, minHeightCm: 130 },
      });
      const dep = await fx.departure();
      const created = await http()
        .post('/api/bookings')
        .set(operator.auth)
        .send({
          departureId: dep.id,
          currency: 'USD',
          adults: 2,
          customer: customerInput(),
          billing: billingBoleta,
          sendConfirmation: false,
          passengers: [
            { firstName: 'Ana', lastName: 'Pérez' },
            { firstName: 'Luis', lastName: 'Pérez' },
          ],
        })
        .expect(201);
      const bookingId = (created.body as Body).id as string;
      const waivers = await prisma.waiver.findMany({
        where: { bookingId },
        include: { passenger: true },
        orderBy: { createdAt: 'asc' },
      });
      expect(waivers).toHaveLength(2);
      const [w1] = waivers;

      const form = await http()
        .get(`/api/public/waivers/${w1.token}`)
        .expect(200);
      expect(form.body).toMatchObject({
        status: 'PENDING',
        version: 1,
        tourSlug: fx.tour.slug,
        passengerName: 'Ana Pérez',
        minAge: 12,
        minHeightCm: 130,
      });

      const sign = {
        signerName: 'Ana Pérez',
        signerDocType: 'DNI',
        signerDocNumber: '12345678',
        medicalNotes: 'Asma leve',
        emergencyContactName: 'Carlos Pérez',
        emergencyContactPhone: '+51911222333',
        accepted: true,
      };
      await http()
        .post(`/api/public/waivers/${w1.token}/sign`)
        .send({ ...sign, accepted: false })
        .expect(422);
      await http()
        .post(`/api/public/waivers/${w1.token}/sign`)
        .send({ ...sign, signerDocNumber: '1' })
        .expect(422);
      const signed = await http()
        .post(`/api/public/waivers/${w1.token}/sign`)
        .set('X-Forwarded-For', '203.0.113.9')
        .send(sign)
        .expect(200);
      expect(signed.body).toMatchObject({ status: 'SIGNED' });
      await http()
        .post(`/api/public/waivers/${w1.token}/sign`)
        .send(sign)
        .expect(409);

      const row = await prisma.waiver.findUniqueOrThrow({
        where: { id: w1.id },
        include: { passenger: true },
      });
      expect(row).toMatchObject({
        status: 'SIGNED',
        signerName: 'Ana Pérez',
        medicalNotes: 'Asma leve',
      });
      expect(row.signedAt).toBeTruthy();
      expect(row.passenger).toMatchObject({
        emergencyContactName: 'Carlos Pérez',
      });

      const list = await http()
        .get('/api/waivers')
        .query({ bookingId, status: 'SIGNED' })
        .set(operator.auth)
        .expect(200);
      expect((list.body as { data: Body[] }).data).toHaveLength(1);
      expect(
        (
          await http()
            .get('/api/waivers')
            .query({ bookingId })
            .set(operator.auth)
            .expect(200)
        ).body,
      ).toHaveProperty('data');
      await http().get('/api/public/waivers/unknown').expect(404);

      // El manifiesto lo refleja.
      const manifest = await http()
        .get(`/api/departures/${dep.id}/manifest`)
        .set(operator.auth)
        .expect(200);
      const rows = (manifest.body as { passengers: Body[] }).passengers;
      expect(rows.find((p) => p.name === 'Ana Pérez')).toMatchObject({
        waiverStatus: 'SIGNED',
        medicalNotes: 'Asma leve',
        emergencyContactName: 'Carlos Pérez',
      });
      expect(rows.find((p) => p.name === 'Luis Pérez')).toMatchObject({
        waiverStatus: 'PENDING',
      });
    });

    it('does not credit one passenger with the signature of another seat', async () => {
      const fx = await createCatalog(app);
      const dep = await fx.departure();
      const created = await http()
        .post('/api/bookings')
        .set(operator.auth)
        .send({
          departureId: dep.id,
          currency: 'USD',
          adults: 3,
          customer: customerInput(),
          billing: billingBoleta,
          sendConfirmation: false,
          passengers: [{ firstName: 'Ana', lastName: 'Pérez' }],
        })
        .expect(201);
      const bookingId = (created.body as Body).id as string;
      const unnamed = await prisma.waiver.findFirstOrThrow({
        where: { bookingId, passengerId: null },
      });
      await http()
        .post(`/api/public/waivers/${unnamed.token}/sign`)
        .send({
          signerName: 'Otro',
          signerDocType: 'DNI',
          signerDocNumber: '12345678',
          medicalNotes: 'Alergia',
          accepted: true,
        })
        .expect(200);
      const manifest = await http()
        .get(`/api/departures/${dep.id}/manifest`)
        .set(operator.auth)
        .expect(200);
      const ana = (manifest.body as { passengers: Body[] }).passengers.find(
        (p) => p.name === 'Ana Pérez',
      )!;
      expect(ana.waiverStatus).toBe('PENDING');
      expect(ana.medicalNotes).toBeNull();
    });

    it('lets only one of several simultaneous signatures win', async () => {
      const fx = await createCatalog(app);
      const dep = await fx.departure();
      const created = await http()
        .post('/api/bookings')
        .set(operator.auth)
        .send({
          departureId: dep.id,
          currency: 'USD',
          adults: 1,
          customer: customerInput(),
          billing: billingBoleta,
          sendConfirmation: false,
        })
        .expect(201);
      const waiver = await prisma.waiver.findFirstOrThrow({
        where: { bookingId: (created.body as Body).id },
      });
      const sign = {
        signerName: 'X Y',
        signerDocType: 'DNI',
        signerDocNumber: '12345678',
        accepted: true,
      };
      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          http().post(`/api/public/waivers/${waiver.token}/sign`).send(sign),
        ),
      );
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      expect(results.filter((r) => r.status === 409)).toHaveLength(4);
    });

    it('does not let a cancelled booking sign', async () => {
      const fx = await createCatalog(app);
      const dep = await fx.departure();
      const created = await http()
        .post('/api/bookings')
        .set(operator.auth)
        .send({
          departureId: dep.id,
          currency: 'USD',
          adults: 1,
          customer: customerInput(),
          billing: billingBoleta,
          sendConfirmation: false,
        })
        .expect(201);
      const id = (created.body as Body).id as string;
      await http()
        .post(`/api/bookings/${id}/cancel`)
        .set(operator.auth)
        .send({ reason: 'x', refund: 'POLICY' })
        .expect(200);
      const waiver = await prisma.waiver.findFirstOrThrow({
        where: { bookingId: id },
      });
      await http()
        .post(`/api/public/waivers/${waiver.token}/sign`)
        .send({
          signerName: 'X Y',
          signerDocType: 'DNI',
          signerDocNumber: '12345678',
          accepted: true,
        })
        .expect(409);
    });
  });

  describe('waiver versions', () => {
    const publish = (body: Body, who = admin) =>
      http().post('/api/legal-documents').set(who.auth).send(body);

    /** Tour con `requiresWaiver` y sin snapshot: `createCatalog` ya publica uno en inglés. */
    const bareTour = async (prefix = 'fx') => {
      const slug = `${prefix}-${rand()}-${rand()}`;
      return prisma.tourRef.create({
        data: { slug, title: `Tour ${slug}`, requiresWaiver: true },
      });
    };

    const manualBooking = (departureId: string, locale?: string) =>
      http()
        .post('/api/bookings')
        .set(operator.auth)
        .send({
          departureId,
          currency: 'USD',
          adults: 1,
          customer: customerInput({ ...(locale ? { locale } : {}) }),
          billing: billingBoleta,
          sendConfirmation: false,
        });

    it('publishes a snapshot per tour and language, with its own version counter', async () => {
      const a = await bareTour();
      const b = await bareTour();
      const es1 = await publish({
        kind: 'WAIVER',
        locale: 'es',
        tourRefId: a.id,
      }).expect(201);
      const es2 = await publish({
        kind: 'WAIVER',
        locale: 'es',
        tourRefId: a.id,
      }).expect(201);
      const en1 = await publish({
        kind: 'WAIVER',
        locale: 'en',
        tourRefId: a.id,
      }).expect(201);
      const otherTour = await publish({
        kind: 'WAIVER',
        locale: 'es',
        tourRefId: b.id,
      }).expect(201);
      expect(
        [es1, es2, en1, otherTour].map((r) => (r.body as Body).version),
      ).toEqual([1, 2, 1, 1]);
      expect(es1.body as Body).toMatchObject({
        kind: 'WAIVER',
        locale: 'es',
        tourRefId: a.id,
        cmsSlug: a.slug,
        title: `Tour ${a.slug} (es)`,
      });
      const row = await prisma.legalDocument.findUniqueOrThrow({
        where: { id: (es1.body as Body).id },
      });
      expect(row.textSnapshot).toBe(
        `# Descargo de ${a.slug}\n\nTexto del descargo en es.`,
      );
      expect(row.contentHash).toBe((es1.body as Body).contentHash);
      // Es inmutable como los demás documentos legales.
      await expect(
        prisma.legalDocument.update({
          where: { id: row.id },
          data: { textSnapshot: 'otro' },
        }),
      ).rejects.toThrow();
      expect(
        await prisma.auditLog.count({
          where: { entityId: row.id, action: 'legalDocument.publish' },
        }),
      ).toBe(1);
    });

    it('does not mix versions when published at the same time', async () => {
      const t = await bareTour();
      const results = await Promise.all(
        [1, 2, 3, 4].map(() =>
          publish({ kind: 'WAIVER', locale: 'es', tourRefId: t.id }),
        ),
      );
      expect(results.map((r) => r.status)).toEqual([201, 201, 201, 201]);
      expect(
        results.map((r) => (r.body as Body).version as number).sort(),
      ).toEqual([1, 2, 3, 4]);
    });

    it('fails with a clear error when the CMS data is missing', async () => {
      const noTour = await bareTour('sin-tour');
      const noText = await bareTour('sin-descargo');
      const missingTour = await publish({
        kind: 'WAIVER',
        locale: 'es',
        tourRefId: noTour.id,
      }).expect(422);
      expect((missingTour.body as Body).message).toContain(
        `no tour "${noTour.slug}"`,
      );
      const missingText = await publish({
        kind: 'WAIVER',
        locale: 'es',
        tourRefId: noText.id,
      }).expect(422);
      expect(JSON.stringify(missingText.body)).toContain('waiverBody');
      expect(
        await prisma.legalDocument.count({
          where: { tourRefId: { in: [noTour.id, noText.id] } },
        }),
      ).toBe(0);
    });

    it('validates tourRefId and cmsSlug by kind and needs legal:write', async () => {
      const t = await bareTour();
      await publish({ kind: 'WAIVER', locale: 'es' }).expect(422);
      await publish({
        kind: 'WAIVER',
        locale: 'es',
        tourRefId: '00000000-0000-4000-8000-000000000000',
      }).expect(422);
      await publish({
        kind: 'WAIVER',
        locale: 'es',
        tourRefId: t.id,
        cmsSlug: 'terms',
      }).expect(422);
      await publish({
        kind: 'TERMS',
        locale: LOCALE,
        cmsSlug: 'terms',
        tourRefId: t.id,
      }).expect(422);
      await publish({ kind: 'TERMS', locale: LOCALE }).expect(422);
      await publish(
        { kind: 'WAIVER', locale: 'es', tourRefId: t.id },
        operator,
      ).expect(403);
    });

    it('lists versions with filters and keeps waivers out of the current legal documents', async () => {
      const t = await bareTour();
      await publish({ kind: 'WAIVER', locale: 'es', tourRefId: t.id }).expect(
        201,
      );
      await publish({ kind: 'WAIVER', locale: 'en', tourRefId: t.id }).expect(
        201,
      );
      await publish({ kind: 'WAIVER', locale: 'es', tourRefId: t.id }).expect(
        201,
      );
      const list = await http()
        .get('/api/legal-documents')
        .query({ tourRefId: t.id, kind: 'WAIVER' })
        .set(operator.auth)
        .expect(200);
      const body = list.body as { data: Body[]; meta: Body };
      expect(body.meta.total).toBe(3);
      expect(body.data.map((d) => `${d.locale}/${d.version}`).sort()).toEqual([
        'en/1',
        'es/1',
        'es/2',
      ]);
      const onlyEs = await http()
        .get('/api/legal-documents')
        .query({ tourRefId: t.id, locale: 'es' })
        .set(operator.auth)
        .expect(200);
      expect((onlyEs.body as { data: Body[] }).data).toHaveLength(2);
      await http()
        .get('/api/legal-documents')
        .query({ kind: 'X' })
        .set(operator.auth)
        .expect(422);
      await http().get('/api/legal-documents').expect(401);

      const current = await http()
        .get('/api/public/legal-documents/current')
        .query({ locale: 'es' })
        .expect(200);
      expect(
        (current.body as { data: Body[] }).data.some(
          (d) => d.kind === 'WAIVER',
        ),
      ).toBe(false);
    });

    it('refuses a waiver as an accepted legal document when booking', async () => {
      const fx = await createCatalog(app);
      const waiverDoc = await prisma.legalDocument.findFirstOrThrow({
        where: { tourRefId: fx.tour.id },
      });
      const ids = await publishLegal(app, admin, LOCALE);
      const dep = await fx.departure();
      const h = await http()
        .post('/api/public/holds')
        .send({ departureId: dep.id, seats: 1 })
        .expect(201);
      await http()
        .post('/api/public/bookings')
        .send({
          holdToken: (h.body as Body).token,
          currency: 'USD',
          adults: 1,
          customer: customerInput({ locale: LOCALE }),
          billing: billingBoleta,
          paymentKind: 'FULL',
          acceptedLegalDocumentIds: [...ids, waiverDoc.id],
          locale: LOCALE,
        })
        .expect(422);
    });

    it('points each waiver at the latest snapshot of the booking language, falling back to English', async () => {
      const fx = await createCatalog(app); // ya trae la versión 1 en inglés
      await publishWaiverSnapshot(prisma, fx.tour, 'en'); // en v2
      const es1 = await publishWaiverSnapshot(prisma, fx.tour, 'es');
      const dep = await fx.departure();

      const spanish = await manualBooking(dep.id, 'es-PE').expect(201);
      const french = await manualBooking(dep.id, 'fr').expect(201);
      const withVersion = async (res: { body: unknown }) =>
        prisma.waiver.findFirstOrThrow({
          where: { bookingId: (res.body as Body).id },
          include: { legalDocument: true },
        });
      // 'es-PE' no es 'es': las versiones se buscan por el idioma exacto de la reserva.
      const w1 = await withVersion(spanish);
      expect(w1.legalDocument).toMatchObject({ locale: 'en', version: 2 });
      expect(w1.version).toBe(2);

      const exact = await manualBooking(dep.id, 'es').expect(201);
      const w2 = await withVersion(exact);
      expect(w2.legalDocumentId).toBe(es1.id);
      expect(w2.version).toBe(es1.version);

      const w3 = await withVersion(french);
      expect(w3.legalDocument).toMatchObject({ locale: 'en', version: 2 });
    });

    it('shows the signer the pinned snapshot even after a newer version is published', async () => {
      const fx = await createCatalog(app);
      const dep = await fx.departure();
      const created = await manualBooking(dep.id).expect(201);
      const waiver = await prisma.waiver.findFirstOrThrow({
        where: { bookingId: (created.body as Body).id },
      });
      const v1 = await prisma.legalDocument.findFirstOrThrow({
        where: { tourRefId: fx.tour.id, locale: 'en', version: 1 },
      });
      await publish({
        kind: 'WAIVER',
        locale: 'en',
        tourRefId: fx.tour.id,
      }).expect(201);

      const form = await http()
        .get(`/api/public/waivers/${waiver.token}`)
        .expect(200);
      expect(form.body as Body).toMatchObject({
        version: 1,
        locale: 'en',
        title: v1.title,
        body: v1.textSnapshot,
        contentHash: v1.contentHash,
      });
      const signed = await http()
        .post(`/api/public/waivers/${waiver.token}/sign`)
        .send({
          signerName: 'Ana Pérez',
          signerDocType: 'DNI',
          signerDocNumber: '12345678',
          accepted: true,
        })
        .expect(200);
      expect((signed.body as Body).contentHash).toBe(v1.contentHash);
      const list = await http()
        .get('/api/waivers')
        .query({ bookingId: (created.body as Body).id })
        .set(operator.auth)
        .expect(200);
      expect((list.body as { data: Body[] }).data[0]).toMatchObject({
        version: 1,
        legalDocumentId: v1.id,
      });
    });

    it('blocks bookings of a tour without a published waiver text, and does not need one when it requires none', async () => {
      const fx = await createCatalog(app, { requiresWaiver: false });
      const dep = await fx.departure();
      await manualBooking(dep.id).expect(201);

      const tour = await bareTour();
      await prisma.priceRule.create({
        data: {
          tourRefId: tour.id,
          currency: 'USD',
          adultCents: 10000,
          childCents: 6000,
        },
      });
      const open = await prisma.departure.create({
        data: {
          tourRefId: tour.id,
          startsAt: new Date(Date.now() + 10 * 86_400_000),
          capacity: 5,
        },
      });
      const denied = await manualBooking(open.id).expect(409);
      expect(JSON.stringify(denied.body)).toContain('waiver text');
      // Nada quedó a medias: ni reserva ni cupo tomado.
      expect(
        await prisma.booking.count({ where: { departureId: open.id } }),
      ).toBe(0);

      const ids = await publishLegal(app, admin, LOCALE);
      const h = await http()
        .post('/api/public/holds')
        .send({ departureId: open.id, seats: 1 })
        .expect(201);
      await http()
        .post('/api/public/bookings')
        .send({
          holdToken: (h.body as Body).token,
          currency: 'USD',
          adults: 1,
          customer: customerInput({ locale: LOCALE }),
          billing: billingBoleta,
          paymentKind: 'FULL',
          acceptedLegalDocumentIds: ids,
          locale: LOCALE,
        })
        .expect(409);
      await publishWaiverSnapshot(prisma, tour);
      await manualBooking(open.id).expect(201);
    });
  });

  describe('contact messages and consents', () => {
    it('stores a contact message and notifies the staff address when configured', async () => {
      const email = `contacto-${rand()}@example.com`;
      await http()
        .post('/api/public/contact-messages')
        .send({
          name: 'Marta',
          email,
          whatsapp: '51999',
          country: 'PE',
          message: '¿Hay cupo en diciembre?',
          locale: 'es',
        })
        .expect(202);
      const row = await prisma.contactMessage.findFirstOrThrow({
        where: { email },
      });
      expect(row).toMatchObject({
        name: 'Marta',
        message: '¿Hay cupo en diciembre?',
        handled: false,
      });
      await http()
        .post('/api/public/contact-messages')
        .send({ name: 'M', email: 'no', message: 'x' })
        .expect(422);
      await http()
        .post('/api/public/contact-messages')
        .send({ name: 'M', email })
        .expect(422);
    });

    it('records cookie consent keeping only boolean categories', async () => {
      const anonymousId = `anon-${rand()}-${rand()}`;
      await http()
        .post('/api/public/consents')
        .send({
          anonymousId,
          categories: {
            analytics: true,
            marketing: false,
            'bad key': true,
            weird: 'yes',
          },
          policyVersion: 2,
        })
        .expect(204);
      const row = await prisma.consentRecord.findFirstOrThrow({
        where: { anonymousId },
      });
      expect(row.categories).toEqual({ analytics: true, marketing: false });
      expect(row.policyVersion).toBe(2);
      await http()
        .post('/api/public/consents')
        .send({ anonymousId: 'x', categories: {}, policyVersion: 1 })
        .expect(422);
      await http()
        .post('/api/public/consents')
        .send({ anonymousId, categories: 'all', policyVersion: 1 })
        .expect(422);
    });
  });

  describe('audit log', () => {
    it('is insert-only at the database level', async () => {
      const entry = await prisma.auditLog.findFirstOrThrow();
      await expect(
        prisma.auditLog.update({
          where: { id: entry.id },
          data: { action: 'tampered' },
        }),
      ).rejects.toThrow(/insert-only/);
      await expect(
        prisma.auditLog.delete({ where: { id: entry.id } }),
      ).rejects.toThrow(/insert-only/);
      await expect(
        prisma.auditLog.deleteMany({ where: { id: entry.id } }),
      ).rejects.toThrow();
    });
  });
});
