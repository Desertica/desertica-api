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
