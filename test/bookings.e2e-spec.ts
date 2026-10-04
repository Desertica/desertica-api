import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { ExpiryService } from '../src/modules/bookings/expiry.service';
import { LogMailer } from '../src/modules/notifications/log-mailer';
import { MAILER } from '../src/modules/notifications/mailer';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  billingBoleta,
  CatalogFixture,
  createCatalog,
  customerInput,
  HOUR,
  inHours,
  publishLegal,
  rand,
} from './fixtures';
import { createTestApp, loginAs, TestSession } from './helpers';

type Body = Record<string, any>;
// Idioma propio de cada corrida: los textos legales son inmutables y no se pueden borrar.
const letters = 'abcdefghijklmnopqrstuvwxyz';
const pick = () => letters[Math.floor(Math.random() * 26)];
const LOCALE = `q${pick()}-${pick()}${pick()}`.replace(
  /-(..)/,
  (_m, x: string) => `-${x.toUpperCase()}`,
);

describe('Reservas (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let mailer: LogMailer;
  let admin: TestSession;
  let operator: TestSession;
  let legalIds: string[];
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    mailer = app.get<LogMailer>(MAILER);
    admin = await loginAs(app, 'admin');
    operator = await loginAs(app, 'operator');
    legalIds = await publishLegal(app, admin, LOCALE);
  });
  afterAll(async () => {
    await app.close();
  });

  const hold = (departureId: string, seats = 2) =>
    http().post('/api/public/holds').send({ departureId, seats });

  const bookingBody = (token: string, over: Body = {}) => ({
    holdToken: token,
    currency: 'USD',
    adults: 2,
    customer: customerInput({ locale: LOCALE }),
    billing: billingBoleta,
    paymentKind: 'FULL',
    acceptedLegalDocumentIds: legalIds,
    locale: LOCALE,
    ...over,
  });

  /** Reserva web completa (bloqueo + reserva). */
  async function webBooking(
    departureId: string,
    over: Body = {},
    seats = (over.adults ?? 2) + (over.children ?? 0),
  ) {
    const h = await hold(departureId, seats).expect(201);
    const res = await http()
      .post('/api/public/bookings')
      .send(bookingBody((h.body as Body).token, over))
      .expect(201);
    const body = res.body as Body;
    const row = await prisma.booking.findUniqueOrThrow({
      where: { reference: body.booking.reference },
    });
    return {
      id: row.id,
      reference: body.booking.reference as string,
      token: body.accessToken as string,
      body,
    };
  }

  // ------------------------------------------------------------------ Cupos
  describe('seat holds', () => {
    let fx: CatalogFixture;
    beforeAll(async () => {
      fx = await createCatalog(app);
    });

    it('reserves seats, shows them in availability and gives them back on release', async () => {
      const dep = await fx.departure({ capacity: 5 });
      const month = dep.startsAt.toISOString().slice(0, 7);
      const left = async () => {
        const res = await http()
          .get(`/api/public/tours/${fx.tour.slug}/availability`)
          .query({ month, currency: 'USD' })
          .expect(200);
        return (res.body as { data: Body[] }).data.find(
          (d) => d.departureId === dep.id,
        )!.seatsLeft as number;
      };
      expect(await left()).toBe(5);

      const res = await hold(dep.id, 3).expect(201);
      const h = res.body as Body;
      expect(h).toMatchObject({ departureId: dep.id, seats: 3 });
      expect(new Date(h.expiresAt).getTime()).toBeGreaterThan(Date.now());
      expect(await left()).toBe(2);

      await hold(dep.id, 3).expect(409);
      await http().delete(`/api/public/holds/${h.token}`).expect(204);
      await http().delete(`/api/public/holds/${h.token}`).expect(204); // idempotente
      expect(await left()).toBe(5);
    });

    it('rejects unknown, closed and past-cutoff departures', async () => {
      await hold('00000000-0000-4000-8000-000000000000', 1).expect(404);
      const closed = await fx.departure({ capacity: 5 });
      await prisma.departure.update({
        where: { id: closed.id },
        data: { status: 'CLOSED' },
      });
      await hold(closed.id, 1).expect(409);
      const cutoff = await fx.departure({
        startsAt: inHours(2),
        cutoffMinutes: 180,
      });
      await hold(cutoff.id, 1).expect(409);
      await http()
        .post('/api/public/holds')
        .send({ departureId: closed.id, seats: 0 })
        .expect(422);
    });

    it('lets exactly one of many simultaneous holds take the last seat', async () => {
      const dep = await fx.departure({ capacity: 1 });
      const results = await Promise.all(
        Array.from({ length: 12 }, () => hold(dep.id, 1)),
      );
      const statuses = results.map((r) => r.status);
      expect(statuses.filter((s) => s === 201)).toHaveLength(1);
      expect(statuses.filter((s) => s === 409)).toHaveLength(11);
      expect(await prisma.hold.count({ where: { departureId: dep.id } })).toBe(
        1,
      );
    });

    it('never oversells with simultaneous holds of different sizes', async () => {
      const dep = await fx.departure({ capacity: 7 });
      const sizes = [3, 3, 3, 2, 2, 1, 1, 1, 4, 5];
      const results = await Promise.all(sizes.map((n) => hold(dep.id, n)));
      const granted = results
        .map((r, i) => (r.status === 201 ? sizes[i] : 0))
        .reduce((a, b) => a + b, 0);
      expect(granted).toBeLessThanOrEqual(7);
      expect(results.every((r) => r.status === 201 || r.status === 409)).toBe(
        true,
      );
    });

    it('serializes simultaneous manual bookings and holds on the same last seats', async () => {
      const dep = await fx.departure({ capacity: 2 });
      const manual = () =>
        http().post('/api/bookings').set(operator.auth).send({
          departureId: dep.id,
          currency: 'USD',
          adults: 1,
          customer: customerInput(),
          billing: billingBoleta,
          sendConfirmation: false,
        });
      const results = await Promise.all([
        manual(),
        manual(),
        manual(),
        hold(dep.id, 1),
        hold(dep.id, 1),
      ]);
      expect(results.filter((r) => r.status === 201)).toHaveLength(2);
      expect(results.filter((r) => r.status === 409)).toHaveLength(3);
    });
  });

  // ---------------------------------------------------------- Reserva web
  describe('public booking', () => {
    let fx: CatalogFixture;
    beforeAll(async () => {
      fx = await createCatalog(app);
    });

    it('creates a pending booking from a hold and exposes it with the access token', async () => {
      const dep = await fx.departure({ capacity: 6 });
      const h = await hold(dep.id, 3).expect(201);
      const res = await http()
        .post('/api/public/bookings')
        .set('Idempotency-Key', `k-${rand()}`)
        .send(
          bookingBody((h.body as Body).token, {
            adults: 2,
            children: 1,
            paymentKind: 'DEPOSIT',
            passengers: [
              { firstName: 'Ana', lastName: 'Pérez' },
              { firstName: 'Luis', lastName: 'Pérez' },
            ],
            attribution: { utmSource: 'google', gclid: 'abc' },
          }),
        )
        .expect(201);
      const body = res.body as Body;
      expect(body.booking).toMatchObject({
        status: 'PENDING_PAYMENT',
        tourSlug: fx.tour.slug,
        adults: 2,
        children: 1,
        currency: 'USD',
        totalCents: 26000, // 2 × 100,00 + 1 × 60,00
        paidCents: 0,
        pendingCents: 26000,
        depositCents: 7800, // 30 %
        meetingPoint: 'Plaza de Armas',
      });
      expect(body.booking.reference).toMatch(/^DST-[A-Z0-9]{6}$/);
      expect(body.booking.cancellationTiers[0]).toEqual({
        hoursBefore: 48,
        refundPercent: 100,
      });
      expect(body.booking.waivers).toHaveLength(3); // uno por asiento
      expect(
        body.booking.waivers.filter((w: Body) => w.passengerName),
      ).toHaveLength(2);
      expect(body.paymentOptions).toEqual([
        { provider: 'STRIPE', kinds: ['DEPOSIT'] },
        { provider: 'CULQI', kinds: ['DEPOSIT'] },
      ]);

      const ref = body.booking.reference as string;
      const view = await http()
        .get(`/api/public/bookings/${ref}`)
        .set('X-Booking-Token', body.accessToken)
        .expect(200);
      expect((view.body as Body).reference).toBe(ref);

      // Lo guardado: hash del token, aceptaciones, atribución y auditoría.
      const row = await prisma.booking.findUniqueOrThrow({
        where: { reference: ref },
        include: { accessTokens: true, acceptances: true },
      });
      expect(row.accessTokens).toHaveLength(1);
      expect(row.accessTokens[0].tokenHash).not.toBe(body.accessToken);
      expect(row.acceptances.map((a) => a.legalDocumentId).sort()).toEqual(
        [...legalIds].sort(),
      );
      expect(row.attribution).toMatchObject({
        utmSource: 'google',
        gclid: 'abc',
      });
      expect(row.source).toBe('WEB');
      expect((row.priceSnapshot as Body).totalCents).toBe(26000);
      expect((row.cancellationSnapshot as Body).policyId).toBe(fx.policyId);
      const audit = await prisma.auditLog.count({
        where: { entityId: row.id, action: 'booking.create' },
      });
      expect(audit).toBe(1);

      const mail = mailer.sent.find(
        (m) => m.to === row.customerId || (m.data as Body).reference === ref,
      );
      expect(mail?.template).toBe('booking_created');
      expect(String((mail!.data as Body).bookingUrl)).toContain(
        body.accessToken,
      );
    });

    it('keeps the price chosen at booking time even if rules change later', async () => {
      const dep = await fx.departure();
      const { id, reference, token } = await webBooking(dep.id, { adults: 2 });
      await prisma.priceRule.updateMany({
        where: { tourRefId: fx.tour.id, currency: 'USD' },
        data: { adultCents: 99999 },
      });
      const view = await http()
        .get(`/api/public/bookings/${reference}`)
        .set('X-Booking-Token', token)
        .expect(200);
      expect((view.body as Body).totalCents).toBe(20000);
      expect(
        (await prisma.booking.findUniqueOrThrow({ where: { id } })).totalCents,
      ).toBe(20000);
      await prisma.priceRule.updateMany({
        where: { tourRefId: fx.tour.id, currency: 'USD' },
        data: { adultCents: 10000 },
      });
    });

    it('refuses a refund-producing reschedule without payments:refund', async () => {
      const lowRole = await prisma.role.upsert({
        where: { key: 'norefund' },
        update: {},
        create: {
          key: 'norefund',
          name: 'Sin reembolsos',
          permissions: [
            'bookings:read',
            'bookings:write',
            'payments:write',
            'departures:read',
          ],
        },
      });
      const email = `norefund-${rand()}@desertica.pe`;
      await prisma.user.create({
        data: { email, name: 'NR', roleId: lowRole.id },
      });
      const login = await http()
        .post('/api/auth/google')
        .send({ idToken: `fake:${email}` })
        .expect(200);
      const auth = {
        Authorization: `Bearer ${(login.body as Body).accessToken}`,
      };
      const a = await fx.departure();
      const cheap = await fx.departure({ startsAt: inHours(24 * 15) });
      const day = cheap.startsAt.toISOString().slice(0, 10);
      const rule = await prisma.priceRule.create({
        data: {
          tourRefId: fx.tour.id,
          currency: 'USD',
          adultCents: 5000,
          priority: 20,
          validFrom: new Date(day),
          validTo: new Date(day),
        },
      });
      const { id } = await webBooking(a.id, { adults: 1 });
      await http()
        .post(`/api/bookings/${id}/payments/manual`)
        .set(auth)
        .send({
          method: 'CASH',
          kind: 'FULL',
          amountCents: 10000,
          currency: 'USD',
        })
        .expect(201);
      await http()
        .post(`/api/bookings/${id}/reschedule`)
        .set(auth)
        .send({ targetDepartureId: cheap.id })
        .expect(403);
      expect(
        (await prisma.booking.findUniqueOrThrow({ where: { id } })).departureId,
      ).toBe(a.id);
      await http()
        .post(`/api/bookings/${id}/reschedule`)
        .set(operator.auth)
        .send({ targetDepartureId: cheap.id })
        .expect(200);
      await prisma.priceRule.update({
        where: { id: rule.id },
        data: { active: false },
      });
    });

    it('is idempotent with Idempotency-Key and rejects a different body', async () => {
      const dep = await fx.departure();
      const h = await hold(dep.id, 2).expect(201);
      const key = `idem-${rand()}`;
      const body = bookingBody((h.body as Body).token);
      const first = await http()
        .post('/api/public/bookings')
        .set('Idempotency-Key', key)
        .send(body)
        .expect(201);
      const second = await http()
        .post('/api/public/bookings')
        .set('Idempotency-Key', key)
        .send(body)
        .expect(201);
      expect((second.body as Body).booking.reference).toBe(
        (first.body as Body).booking.reference,
      );
      expect((second.body as Body).accessToken).toBeDefined();
      expect((second.body as Body).accessToken).not.toBe(
        (first.body as Body).accessToken,
      );
      expect(
        await prisma.booking.count({ where: { departureId: dep.id } }),
      ).toBe(1);

      await http()
        .post('/api/public/bookings')
        .set('Idempotency-Key', key)
        .send({ ...body, notes: 'otra cosa' })
        .expect(422);

      // El secreto no queda en claro en la tabla de idempotencia.
      const stored = await prisma.idempotencyRecord.findUniqueOrThrow({
        where: { scope_key: { scope: 'createPublicBooking', key } },
      });
      expect(JSON.stringify(stored.body)).not.toContain(
        (first.body as Body).accessToken,
      );
      expect(JSON.stringify(stored.body)).not.toContain(
        (first.body as Body).booking.waivers[0].token,
      );
    });

    it('does not overwrite an existing customer from the public flow', async () => {
      const dep = await fx.departure();
      const email = `fijo-${rand()}@example.com`;
      const base = customerInput({
        email,
        firstName: 'Mario',
        lastName: 'Rojas',
        phone: '+51900111222',
        locale: LOCALE,
      });
      await webBooking(dep.id, { customer: base, adults: 1 });
      await webBooking(dep.id, {
        customer: { ...base, phone: '+51999999999', idDocNumber: '99999999' },
        adults: 1,
      });
      const customers = await prisma.customer.findMany({ where: { email } });
      expect(customers).toHaveLength(1);
      expect(customers[0]).toMatchObject({
        phone: '+51900111222',
        idDocNumber: '12345678',
      });
    });

    it('lets only one of several simultaneous retries create the booking', async () => {
      const dep = await fx.departure();
      const h = await hold(dep.id, 2).expect(201);
      const key = `race-${rand()}`;
      const body = bookingBody((h.body as Body).token);
      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          http()
            .post('/api/public/bookings')
            .set('Idempotency-Key', key)
            .send(body),
        ),
      );
      expect(results.every((r) => r.status === 201)).toBe(true);
      expect(
        new Set(results.map((r) => (r.body as Body).booking.reference)).size,
      ).toBe(1);
      expect(
        await prisma.booking.count({ where: { departureId: dep.id } }),
      ).toBe(1);
    });

    it('without a key a second attempt on the same hold is a conflict', async () => {
      const dep = await fx.departure();
      const h = await hold(dep.id, 2).expect(201);
      const body = bookingBody((h.body as Body).token);
      await http().post('/api/public/bookings').send(body).expect(201);
      await http().post('/api/public/bookings').send(body).expect(409);
      expect(
        await prisma.booking.count({ where: { departureId: dep.id } }),
      ).toBe(1);
    });

    it('rejects expired, released and mismatching holds', async () => {
      const dep = await fx.departure();
      const gone = bookingBody('does-not-exist');
      await http().post('/api/public/bookings').send(gone).expect(410);

      const h = await hold(dep.id, 2).expect(201);
      await prisma.hold.update({
        where: { token: (h.body as Body).token },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      await http()
        .post('/api/public/bookings')
        .send(bookingBody((h.body as Body).token))
        .expect(410);

      const r = await hold(dep.id, 2).expect(201);
      await http()
        .delete(`/api/public/holds/${(r.body as Body).token}`)
        .expect(204);
      await http()
        .post('/api/public/bookings')
        .send(bookingBody((r.body as Body).token))
        .expect(410);

      const m = await hold(dep.id, 2).expect(201);
      await http()
        .post('/api/public/bookings')
        .send(bookingBody((m.body as Body).token, { adults: 1 }))
        .expect(422);
    });

    it('requires the current legal documents, all required kinds, in the booking language', async () => {
      const dep = await fx.departure();
      const attempt = async (ids: string[], over: Body = {}) => {
        const h = await hold(dep.id, 2).expect(201);
        const res = await http()
          .post('/api/public/bookings')
          .send(
            bookingBody((h.body as Body).token, {
              acceptedLegalDocumentIds: ids,
              ...over,
            }),
          );
        if (res.status !== 201)
          await http()
            .delete(`/api/public/holds/${(h.body as Body).token}`)
            .expect(204);
        return res;
      };
      expect((await attempt(legalIds.slice(0, 2))).status).toBe(422); // falta CANCELLATION
      expect(
        (await attempt(['00000000-0000-4000-8000-000000000000', ...legalIds]))
          .status,
      ).toBe(422);
      expect(
        (
          await attempt(legalIds, {
            locale: 'es',
            customer: customerInput({ locale: 'es' }),
          })
        ).status,
      ).toBe(422);

      // Una versión nueva deja obsoleta la anterior.
      const newer = await publishLegal(app, admin, LOCALE);
      expect((await attempt(legalIds)).status).toBe(422);
      expect((await attempt(newer)).status).toBe(201);
      legalIds = newer;
    });

    it('validates billing, party size and currency', async () => {
      const dep = await fx.departure();
      const attempt = async (over: Body) => {
        const h = await hold(dep.id, 2).expect(201);
        const res = await http()
          .post('/api/public/bookings')
          .send(bookingBody((h.body as Body).token, over));
        if (res.status !== 201)
          await http()
            .delete(`/api/public/holds/${(h.body as Body).token}`)
            .expect(204);
        return res.status;
      };
      expect(
        await attempt({ billing: { ...billingBoleta, docType: 'FACTURA' } }),
      ).toBe(422);
      expect(
        await attempt({ billing: { ...billingBoleta, idDocNumber: '12' } }),
      ).toBe(422);
      expect(
        await attempt({
          passengers: [1, 2, 3].map((i) => ({
            firstName: `P${i}`,
            lastName: 'X',
          })),
        }),
      ).toBe(422);
      expect(
        await attempt({
          customer: { ...customerInput(), email: 'no-es-correo' },
        }),
      ).toBe(422);
      expect(await attempt({ unknownField: true })).toBe(422);
      expect(await attempt({ currency: 'EUR' })).toBe(422);
      expect(
        await attempt({
          billing: {
            docType: 'FACTURA',
            name: 'ACME SAC',
            idDocType: 'RUC',
            idDocNumber: '20123456789',
            address: 'Av. Lima 1',
          },
        }),
      ).toBe(201);
    });

    it('sells in PEN with the PEN rule', async () => {
      const dep = await fx.departure();
      const { body } = await webBooking(dep.id, {
        currency: 'PEN',
        adults: 1,
        children: 1,
      });
      expect(body.booking).toMatchObject({
        currency: 'PEN',
        totalCents: 56000,
      });
      expect(body.paymentOptions).toEqual([
        { provider: 'CULQI', kinds: ['FULL'] },
      ]);
    });

    it('does not create waivers when the tour does not require them', async () => {
      const noWaiver = await createCatalog(app, { requiresWaiver: false });
      const dep = await noWaiver.departure();
      const { body } = await webBooking(dep.id);
      expect(body.booking.waivers).toEqual([]);
    });
  });

  // ---------------------------------------------------------- Mi reserva
  describe('"mi reserva" access', () => {
    let fx: CatalogFixture;
    beforeAll(async () => {
      fx = await createCatalog(app);
    });

    it('rejects missing, wrong and cross-booking tokens with the same 401', async () => {
      const dep = await fx.departure();
      const a = await webBooking(dep.id);
      const b = await webBooking(dep.id);
      await http().get(`/api/public/bookings/${a.reference}`).expect(401);
      await http()
        .get(`/api/public/bookings/${a.reference}`)
        .set('X-Booking-Token', 'nope')
        .expect(401);
      await http()
        .get(`/api/public/bookings/${a.reference}`)
        .set('X-Booking-Token', b.token)
        .expect(401);
      await http()
        .get('/api/public/bookings/DST-AAAAAA')
        .set('X-Booking-Token', a.token)
        .expect(401);
    });

    it('rejects an expired token', async () => {
      const dep = await fx.departure();
      const a = await webBooking(dep.id);
      await prisma.bookingAccessToken.updateMany({
        where: { bookingId: a.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      await http()
        .get(`/api/public/bookings/${a.reference}`)
        .set('X-Booking-Token', a.token)
        .expect(401);
    });

    it('emails a new link only when reference and email match, and answers 202 either way', async () => {
      const dep = await fx.departure();
      const email = `acceso-${rand()}@example.com`;
      const a = await webBooking(dep.id, {
        customer: customerInput({ email, locale: LOCALE }),
      });
      const before = mailer.sent.length;

      await http()
        .post('/api/public/bookings/access')
        .send({ reference: 'DST-ZZZZZZ', email })
        .expect(202);
      await http()
        .post('/api/public/bookings/access')
        .send({ reference: a.reference, email: 'otro@example.com' })
        .expect(202);
      expect(
        mailer.sent
          .slice(before)
          .filter((m) => m.template === 'booking_access'),
      ).toHaveLength(0);

      await http()
        .post('/api/public/bookings/access')
        .send({
          reference: a.reference.toLowerCase(),
          email: email.toUpperCase(),
        })
        .expect(202);
      const mail = mailer.sent
        .slice(before)
        .find((m) => m.template === 'booking_access')!;
      expect(mail.to).toBe(email);
      const url = String((mail.data as Body).bookingUrl);
      const token = new URL(url).searchParams.get('token')!;
      await http()
        .get(`/api/public/bookings/${a.reference}`)
        .set('X-Booking-Token', token)
        .expect(200);
    });

    it('limits access emails per address without revealing it', async () => {
      const dep = await fx.departure();
      const email = `limite-${rand()}@example.com`;
      const a = await webBooking(dep.id, {
        customer: customerInput({ email, locale: LOCALE }),
      });
      const before = mailer.sent.length;
      for (let i = 0; i < 6; i++) {
        await http()
          .post('/api/public/bookings/access')
          .send({ reference: a.reference, email })
          .expect(202);
      }
      expect(
        mailer.sent
          .slice(before)
          .filter((m) => m.template === 'booking_access'),
      ).toHaveLength(3);
    });
  });

  // ------------------------------------------------------- Reserva manual
  describe('manual booking', () => {
    let fx: CatalogFixture;
    beforeAll(async () => {
      fx = await createCatalog(app);
    });

    const manual = (dep: string, over: Body = {}) => ({
      departureId: dep,
      currency: 'USD',
      adults: 2,
      customer: customerInput(),
      billing: billingBoleta,
      sendConfirmation: false,
      ...over,
    });

    it('creates a booking without a hold and takes the seats', async () => {
      const dep = await fx.departure({ capacity: 4 });
      const res = await http()
        .post('/api/bookings')
        .set(operator.auth)
        .send(manual(dep.id, { notes: 'WhatsApp' }))
        .expect(201);
      const b = res.body as Body;
      expect(b).toMatchObject({
        status: 'PENDING_PAYMENT',
        source: 'MANUAL',
        totalCents: 20000,
        notes: 'WhatsApp',
      });
      expect(b.customer.email).toBeDefined();
      const d = await http()
        .get(`/api/departures/${dep.id}`)
        .set(operator.auth)
        .expect(200);
      expect((d.body as Body).seatsSold).toBe(2);

      await http()
        .post('/api/bookings')
        .set(operator.auth)
        .send(manual(dep.id, { adults: 3 }))
        .expect(409);
      await http()
        .post('/api/bookings')
        .set(operator.auth)
        .send(manual(dep.id, { adults: 2 }))
        .expect(201);
      await http()
        .post('/api/bookings')
        .set(operator.auth)
        .send(manual(dep.id, { adults: 1 }))
        .expect(409);
    });

    it('needs bookings:override for an agreed price and records it', async () => {
      const dep = await fx.departure();
      await http()
        .post('/api/bookings')
        .set(operator.auth)
        .send(manual(dep.id, { overrideTotalCents: 15000 }))
        .expect(403);
      const res = await http()
        .post('/api/bookings')
        .set(admin.auth)
        .send(manual(dep.id, { overrideTotalCents: 15000 }))
        .expect(201);
      const b = res.body as Body;
      expect(b.totalCents).toBe(15000);
      expect(b.priceSnapshot.override).toMatchObject({
        listTotalCents: 20000,
        overrideTotalCents: 15000,
        byUserId: admin.user.id,
      });
    });

    it('confirms immediately when no payment is required and rejects a deposit above the total', async () => {
      const dep = await fx.departure();
      const free = await http()
        .post('/api/bookings')
        .set(operator.auth)
        .send(manual(dep.id, { depositCents: 0 }))
        .expect(201);
      expect((free.body as Body).status).toBe('CONFIRMED');
      await http()
        .post('/api/bookings')
        .set(operator.auth)
        .send(manual(dep.id, { depositCents: 99999 }))
        .expect(422);
    });

    it('is idempotent per user and key', async () => {
      const dep = await fx.departure();
      const key = `m-${rand()}`;
      const body = manual(dep.id);
      const a = await http()
        .post('/api/bookings')
        .set(operator.auth)
        .set('Idempotency-Key', key)
        .send(body)
        .expect(201);
      const b = await http()
        .post('/api/bookings')
        .set(operator.auth)
        .set('Idempotency-Key', key)
        .send(body)
        .expect(201);
      expect((b.body as Body).id).toBe((a.body as Body).id);
      await http()
        .post('/api/bookings')
        .set(operator.auth)
        .set('Idempotency-Key', key)
        .send({ ...body, adults: 1 })
        .expect(422);
    });

    it('sends the confirmation email unless told not to', async () => {
      const dep = await fx.departure();
      const email = `manual-${rand()}@example.com`;
      const before = mailer.sent.length;
      await http()
        .post('/api/bookings')
        .set(operator.auth)
        .send(
          manual(dep.id, {
            customer: customerInput({ email }),
            sendConfirmation: true,
          }),
        )
        .expect(201);
      expect(
        mailer.sent
          .slice(before)
          .some((m) => m.to === email && m.template === 'booking_created'),
      ).toBe(true);
    });

    it('requires bookings:write', async () => {
      const dep = await fx.departure();
      await http().post('/api/bookings').send(manual(dep.id)).expect(401);
    });
  });

  // ------------------------------------------------------------- Pagos
  describe('payments', () => {
    let fx: CatalogFixture;
    beforeAll(async () => {
      fx = await createCatalog(app);
    });

    it('confirms the booking once the deposit is covered, then settles the balance', async () => {
      const dep = await fx.departure();
      const { id, reference, token } = await webBooking(dep.id, {
        paymentKind: 'DEPOSIT',
      });
      const pay = (body: Body, key?: string) => {
        const r = http()
          .post(`/api/bookings/${id}/payments/manual`)
          .set(operator.auth);
        return (key ? r.set('Idempotency-Key', key) : r).send(body);
      };

      const small = await pay({
        method: 'CASH',
        kind: 'DEPOSIT',
        amountCents: 1000,
        currency: 'USD',
      }).expect(201);
      expect(small.body as Body).toMatchObject({
        provider: 'MANUAL',
        status: 'SUCCEEDED',
        amountCents: 1000,
        bookingReference: reference,
      });
      let b = await http()
        .get(`/api/bookings/${id}`)
        .set(operator.auth)
        .expect(200);
      expect((b.body as Body).status).toBe('PENDING_PAYMENT');

      await pay({
        method: 'YAPE',
        kind: 'DEPOSIT',
        amountCents: 5000,
        currency: 'USD',
        reference: `OP-${rand()}`,
      }).expect(201);
      b = await http()
        .get(`/api/bookings/${id}`)
        .set(operator.auth)
        .expect(200);
      expect(b.body as Body).toMatchObject({
        status: 'CONFIRMED',
        paidCents: 6000,
      });
      expect((b.body as Body).payments).toHaveLength(2);

      await pay({
        method: 'CASH',
        kind: 'BALANCE',
        amountCents: 14001,
        currency: 'USD',
      }).expect(409); // excede
      await pay({
        method: 'CASH',
        kind: 'BALANCE',
        amountCents: 1000,
        currency: 'PEN',
      }).expect(409); // moneda
      await pay({
        method: 'TRANSFER',
        kind: 'BALANCE',
        amountCents: 14000,
        currency: 'USD',
      }).expect(201);

      const view = await http()
        .get(`/api/public/bookings/${reference}`)
        .set('X-Booking-Token', token)
        .expect(200);
      expect(view.body as Body).toMatchObject({
        status: 'CONFIRMED',
        paidCents: 20000,
        pendingCents: 0,
      });
      expect(
        mailer.sent.some(
          (m) =>
            m.template === 'booking_confirmed' &&
            (m.data as Body).reference === reference,
        ),
      ).toBe(true);

      const audits = await prisma.auditLog.findMany({
        where: {
          action: 'payment.manual',
          after: { path: ['bookingId'], equals: id },
        },
      });
      expect(audits).toHaveLength(3);
    });

    it('rejects a duplicated operation number and replays idempotent requests', async () => {
      const dep = await fx.departure();
      const { id } = await webBooking(dep.id);
      const ref = `OP-${rand()}`;
      const body = {
        method: 'TRANSFER',
        kind: 'FULL',
        amountCents: 5000,
        currency: 'USD',
        reference: ref,
      };
      const url = `/api/bookings/${id}/payments/manual`;
      await http().post(url).set(operator.auth).send(body).expect(201);
      await http().post(url).set(operator.auth).send(body).expect(409);

      const key = `p-${rand()}`;
      const p2 = {
        method: 'CASH',
        kind: 'FULL',
        amountCents: 2000,
        currency: 'USD',
      };
      const a = await http()
        .post(url)
        .set(operator.auth)
        .set('Idempotency-Key', key)
        .send(p2)
        .expect(201);
      const b = await http()
        .post(url)
        .set(operator.auth)
        .set('Idempotency-Key', key)
        .send(p2)
        .expect(201);
      expect((b.body as Body).id).toBe((a.body as Body).id);
      const row = await prisma.booking.findUniqueOrThrow({ where: { id } });
      expect(row.paidCents).toBe(7000);
    });

    it('does not lose money under simultaneous payments', async () => {
      const dep = await fx.departure();
      const { id } = await webBooking(dep.id); // 20000
      const results = await Promise.all(
        Array.from({ length: 6 }, () =>
          http()
            .post(`/api/bookings/${id}/payments/manual`)
            .set(operator.auth)
            .send({
              method: 'CASH',
              kind: 'FULL',
              amountCents: 5000,
              currency: 'USD',
            }),
        ),
      );
      expect(results.filter((r) => r.status === 201)).toHaveLength(4);
      expect(results.filter((r) => r.status === 409)).toHaveLength(2);
      const row = await prisma.booking.findUniqueOrThrow({ where: { id } });
      expect(row).toMatchObject({ paidCents: 20000, status: 'CONFIRMED' });
    });

    it('rejects payments on cancelled bookings and checks permissions', async () => {
      const dep = await fx.departure();
      const { id } = await webBooking(dep.id);
      await http()
        .post(`/api/bookings/${id}/cancel`)
        .set(operator.auth)
        .send({ reason: 'x', refund: 'POLICY' })
        .expect(200);
      await http()
        .post(`/api/bookings/${id}/payments/manual`)
        .set(operator.auth)
        .send({
          method: 'CASH',
          kind: 'FULL',
          amountCents: 100,
          currency: 'USD',
        })
        .expect(409);
      await http()
        .post(`/api/bookings/${id}/payments/manual`)
        .send({})
        .expect(401);
    });

    it('creates payment links with the pending amount and exposes them publicly', async () => {
      const dep = await fx.departure();
      const { id, reference } = await webBooking(dep.id, {
        paymentKind: 'DEPOSIT',
      });
      const link = (body: Body) =>
        http()
          .post(`/api/bookings/${id}/payment-links`)
          .set(operator.auth)
          .send(body);

      const deposit = await link({ kind: 'DEPOSIT' }).expect(201);
      expect(deposit.body).toMatchObject({
        kind: 'DEPOSIT',
        amountCents: 6000,
        currency: 'USD',
        usedAt: null,
      });
      expect((deposit.body as Body).url).toContain(
        (deposit.body as Body).token,
      );
      const full = await link({ kind: 'FULL', expiresInHours: 1 }).expect(201);
      expect((full.body as Body).amountCents).toBe(20000);
      await link({ kind: 'FULL', amountCents: 20001 }).expect(422);

      const info = await http()
        .get(`/api/public/payment-links/${(deposit.body as Body).token}`)
        .expect(200);
      expect(info.body).toMatchObject({
        reference,
        kind: 'DEPOSIT',
        amountCents: 6000,
        paymentOptions: ['STRIPE', 'CULQI'],
      });
      await http().get('/api/public/payment-links/unknown').expect(404);
      await prisma.paymentLink.update({
        where: { token: (full.body as Body).token },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      await http()
        .get(`/api/public/payment-links/${(full.body as Body).token}`)
        .expect(410);
      expect(
        mailer.sent.some(
          (m) =>
            m.template === 'payment_link' &&
            (m.data as Body).reference === reference,
        ),
      ).toBe(true);
    });
  });

  // ---------------------------------------------------------- Cancelación
  describe('cancellation', () => {
    let fx: CatalogFixture;
    beforeAll(async () => {
      fx = await createCatalog(app);
    });

    const payFull = (id: string, amountCents = 20000) =>
      http()
        .post(`/api/bookings/${id}/payments/manual`)
        .set(operator.auth)
        .send({ method: 'CASH', kind: 'FULL', amountCents, currency: 'USD' })
        .expect(201);

    it.each([
      [100, 'POLICY', 20000, 100],
      [30, 'POLICY', 10000, 50],
      [3, 'POLICY', 0, 0],
    ])(
      'refunds by tier: %ih before with %s => %i cents (%i%%)',
      async (hours, mode, expected, percent) => {
        const dep = await fx.departure({ startsAt: inHours(hours) });
        const { id } = await webBooking(dep.id);
        await payFull(id);
        const res = await http()
          .post(`/api/bookings/${id}/cancel`)
          .set(operator.auth)
          .send({ reason: 'Cliente enfermo', refund: mode })
          .expect(200);
        const b = res.body as Body;
        expect(b).toMatchObject({
          status: 'CANCELLED',
          cancelReason: 'Cliente enfermo',
          refundDueCents: expected,
          refundedCents: 0,
        });
        expect(b.cancelledAt).toBeTruthy();
        const refunds = await prisma.refund.findMany({
          where: { payment: { bookingId: id } },
        });
        expect(refunds.reduce((s, r) => s + r.amountCents, 0)).toBe(expected);
        expect(refunds.every((r) => r.status === 'PENDING')).toBe(true);
        if (expected > 0)
          expect((refunds[0].policyTier as Body).refundPercent).toBe(percent);
        const audit = await prisma.auditLog.findFirst({
          where: { entityId: id, action: 'booking.cancel' },
        });
        expect((audit!.after as Body).refundDueCents).toBe(expected);
      },
    );

    it('keeps a non-refundable deposit', async () => {
      const dep = await fx.departure({ startsAt: inHours(100) });
      const { id } = await webBooking(dep.id, { paymentKind: 'DEPOSIT' });
      await http()
        .post(`/api/bookings/${id}/payments/manual`)
        .set(operator.auth)
        .send({
          method: 'CASH',
          kind: 'DEPOSIT',
          amountCents: 6000,
          currency: 'USD',
        })
        .expect(201);
      const res = await http()
        .post(`/api/bookings/${id}/cancel`)
        .set(operator.auth)
        .send({ reason: 'x', refund: 'POLICY' })
        .expect(200);
      expect((res.body as Body).refundDueCents).toBe(0);
    });

    it('splits the refund over several payments, newest first', async () => {
      const dep = await fx.departure({ startsAt: inHours(100) });
      const { id } = await webBooking(dep.id);
      await payFull(id, 5000);
      await payFull(id, 15000);
      await http()
        .post(`/api/bookings/${id}/cancel`)
        .set(operator.auth)
        .send({ reason: 'x', refund: 'POLICY' })
        .expect(200);
      const refunds = await prisma.refund.findMany({
        where: { payment: { bookingId: id } },
        orderBy: { amountCents: 'desc' },
      });
      expect(refunds.map((r) => r.amountCents)).toEqual([15000, 5000]);
    });

    it('needs bookings:override to force the amount', async () => {
      const dep = await fx.departure({ startsAt: inHours(3) });
      const { id } = await webBooking(dep.id);
      await payFull(id);
      await http()
        .post(`/api/bookings/${id}/cancel`)
        .set(operator.auth)
        .send({ reason: 'x', refund: 'FULL' })
        .expect(403);
      await http()
        .post(`/api/bookings/${id}/cancel`)
        .set(operator.auth)
        .send({ reason: 'x', refund: 'NONE' })
        .expect(403);
      const res = await http()
        .post(`/api/bookings/${id}/cancel`)
        .set(admin.auth)
        .send({ reason: 'Error nuestro', refund: 'FULL' })
        .expect(200);
      expect((res.body as Body).refundDueCents).toBe(20000);
    });

    it('cancels an unpaid booking without refunds, frees the seats and cannot be repeated', async () => {
      const dep = await fx.departure({ capacity: 2 });
      const { id } = await webBooking(dep.id);
      await hold(dep.id, 1).expect(409);
      await http()
        .post(`/api/bookings/${id}/cancel`)
        .set(operator.auth)
        .send({ reason: 'x', refund: 'POLICY' })
        .expect(200);
      expect(
        await prisma.refund.count({ where: { payment: { bookingId: id } } }),
      ).toBe(0);
      await hold(dep.id, 2).expect(201);
      await http()
        .post(`/api/bookings/${id}/cancel`)
        .set(operator.auth)
        .send({ reason: 'x', refund: 'POLICY' })
        .expect(409);
      expect(mailer.sent.some((m) => m.template === 'booking_cancelled')).toBe(
        true,
      );
    });

    it('validates the request', async () => {
      await http()
        .post('/api/bookings/not-a-uuid/cancel')
        .set(operator.auth)
        .send({ reason: 'x', refund: 'POLICY' })
        .expect(422);
      await http()
        .post('/api/bookings/00000000-0000-4000-8000-000000000000/cancel')
        .set(operator.auth)
        .send({ reason: 'x', refund: 'POLICY' })
        .expect(404);
      await http()
        .post('/api/bookings/00000000-0000-4000-8000-000000000000/cancel')
        .set(operator.auth)
        .send({ refund: 'POLICY' })
        .expect(422);
    });
  });

  // -------------------------------------------------------- Reprogramación
  describe('rescheduling', () => {
    let fx: CatalogFixture;
    beforeAll(async () => {
      fx = await createCatalog(app);
    });

    it('moves a booking, keeping the price when it does not change', async () => {
      const a = await fx.departure();
      const b = await fx.departure();
      const { id } = await webBooking(a.id);
      const res = await http()
        .post(`/api/bookings/${id}/reschedule`)
        .set(operator.auth)
        .send({ targetDepartureId: b.id, reason: 'Pidió otro día' })
        .expect(200);
      const body = res.body as Body;
      expect(body.booking.departureId).toBe(b.id);
      expect(body.adjustment).toBeUndefined();
      expect(body.booking.priceSnapshot.rescheduled).toHaveLength(1);
      expect(
        await prisma.auditLog.count({
          where: { entityId: id, action: 'booking.reschedule' },
        }),
      ).toBe(1);
    });

    it('charges the difference when the target is more expensive', async () => {
      const a = await fx.departure();
      const peak = await fx.departure({ startsAt: inHours(24 * 12) });
      const day = peak.startsAt.toISOString().slice(0, 10);
      const rule = await prisma.priceRule.create({
        data: {
          tourRefId: fx.tour.id,
          currency: 'USD',
          adultCents: 15000,
          priority: 5,
          validFrom: new Date(day),
          validTo: new Date(day),
        },
      });
      const { id } = await webBooking(a.id, { adults: 2 }); // 20000
      await http()
        .post(`/api/bookings/${id}/payments/manual`)
        .set(operator.auth)
        .send({
          method: 'CASH',
          kind: 'FULL',
          amountCents: 20000,
          currency: 'USD',
        })
        .expect(201);
      const res = await http()
        .post(`/api/bookings/${id}/reschedule`)
        .set(operator.auth)
        .send({ targetDepartureId: peak.id })
        .expect(200);
      const body = res.body as Body;
      expect(body.adjustment).toEqual({ type: 'CHARGE', amountCents: 10000 });
      expect(body.booking).toMatchObject({
        totalCents: 30000,
        paidCents: 20000,
        status: 'CONFIRMED',
      });
      await prisma.priceRule.update({
        where: { id: rule.id },
        data: { active: false },
      });
    });

    it('queues a refund for the difference when the target is cheaper', async () => {
      const a = await fx.departure();
      const cheap = await fx.departure({ startsAt: inHours(24 * 13) });
      const day = cheap.startsAt.toISOString().slice(0, 10);
      const rule = await prisma.priceRule.create({
        data: {
          tourRefId: fx.tour.id,
          currency: 'USD',
          adultCents: 8000,
          priority: 9,
          validFrom: new Date(day),
          validTo: new Date(day),
        },
      });
      const { id } = await webBooking(a.id, { adults: 2 });
      await http()
        .post(`/api/bookings/${id}/payments/manual`)
        .set(operator.auth)
        .send({
          method: 'CASH',
          kind: 'FULL',
          amountCents: 20000,
          currency: 'USD',
        })
        .expect(201);
      const res = await http()
        .post(`/api/bookings/${id}/reschedule`)
        .set(operator.auth)
        .send({ targetDepartureId: cheap.id })
        .expect(200);
      const body = res.body as Body;
      expect(body.adjustment).toEqual({ type: 'REFUND', amountCents: 4000 });
      expect(body.booking).toMatchObject({
        totalCents: 16000,
        refundDueCents: 4000,
      });
      await prisma.priceRule.update({
        where: { id: rule.id },
        data: { active: false },
      });
    });

    it('keeps an agreed price', async () => {
      const a = await fx.departure();
      const b = await fx.departure();
      const created = await http()
        .post('/api/bookings')
        .set(admin.auth)
        .send({
          departureId: a.id,
          currency: 'USD',
          adults: 1,
          customer: customerInput(),
          billing: billingBoleta,
          overrideTotalCents: 5000,
          sendConfirmation: false,
        })
        .expect(201);
      const res = await http()
        .post(`/api/bookings/${(created.body as Body).id}/reschedule`)
        .set(operator.auth)
        .send({ targetDepartureId: b.id })
        .expect(200);
      expect((res.body as Body).booking.totalCents).toBe(5000);
      expect((res.body as Body).adjustment).toBeUndefined();
    });

    it('refuses when seats, tour, status or date do not allow it', async () => {
      const a = await fx.departure();
      const full = await fx.departure({ capacity: 1 });
      const { id } = await webBooking(a.id, { adults: 2 });
      const post = (target: string, bookingId = id) =>
        http()
          .post(`/api/bookings/${bookingId}/reschedule`)
          .set(operator.auth)
          .send({ targetDepartureId: target });
      await post(full.id).expect(409); // sin cupo
      await post(a.id).expect(422); // misma salida
      await post('00000000-0000-4000-8000-000000000000').expect(422);

      const other = await createCatalog(app);
      const foreign = await other.departure();
      await post(foreign.id).expect(422); // otro tour

      const past = await prisma.departure.create({
        data: { tourRefId: fx.tour.id, startsAt: inHours(-5), capacity: 5 },
      });
      await post(past.id).expect(409);
      const cancelled = await fx.departure();
      await prisma.departure.update({
        where: { id: cancelled.id },
        data: { status: 'CANCELLED' },
      });
      await post(cancelled.id).expect(409);

      const target = await fx.departure();
      await http()
        .post(`/api/bookings/${id}/cancel`)
        .set(operator.auth)
        .send({ reason: 'x', refund: 'POLICY' })
        .expect(200);
      await post(target.id).expect(409); // ya cancelada
    });

    it('does not oversell when two bookings race for the last seats of the target', async () => {
      const target = await fx.departure({ capacity: 2 });
      const a1 = await fx.departure();
      const [x, y] = await Promise.all([
        webBooking(a1.id, { adults: 2 }),
        webBooking(a1.id, { adults: 2 }),
      ]);
      const results = await Promise.all(
        [x, y].map((b) =>
          http()
            .post(`/api/bookings/${b.id}/reschedule`)
            .set(operator.auth)
            .send({ targetDepartureId: target.id }),
        ),
      );
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    });
  });

  // ------------------------------------------------- Estado, listas y edición
  describe('status, listing and editing', () => {
    let fx: CatalogFixture;
    beforeAll(async () => {
      fx = await createCatalog(app);
    });

    it('marks completed / no-show only for confirmed bookings of a departure that started', async () => {
      const past = await prisma.departure.create({
        data: { tourRefId: fx.tour.id, startsAt: inHours(-3), capacity: 5 },
      });
      const future = await fx.departure();
      const mk = async (departureId: string, status: string) => {
        const c = await prisma.customer.create({
          data: {
            email: `s-${rand()}@example.com`,
            firstName: 'Z',
            lastName: 'Z',
          },
        });
        return prisma.booking.create({
          data: {
            reference: `ST-${rand()}`,
            status: status as 'CONFIRMED',
            departureId,
            customerId: c.id,
            currency: 'USD',
            adults: 1,
            totalCents: 100,
            paidCents: 100,
            priceSnapshot: {},
            cancellationSnapshot: {},
            billing: {
              docType: 'BOLETA',
              name: 'Z Z',
              idDocType: 'DNI',
              idDocNumber: '12345678',
            },
          },
        });
      };
      const ok = await mk(past.id, 'CONFIRMED');
      const res = await http()
        .post(`/api/bookings/${ok.id}/status`)
        .set(operator.auth)
        .send({ status: 'NO_SHOW' })
        .expect(200);
      expect((res.body as Body).status).toBe('NO_SHOW');
      await http()
        .post(`/api/bookings/${ok.id}/status`)
        .set(operator.auth)
        .send({ status: 'COMPLETED' })
        .expect(409);

      const early = await mk(future.id, 'CONFIRMED');
      await http()
        .post(`/api/bookings/${early.id}/status`)
        .set(operator.auth)
        .send({ status: 'COMPLETED' })
        .expect(409);
      const pending = await mk(past.id, 'PENDING_PAYMENT');
      await http()
        .post(`/api/bookings/${pending.id}/status`)
        .set(operator.auth)
        .send({ status: 'COMPLETED' })
        .expect(409);
      await http()
        .post(`/api/bookings/${ok.id}/status`)
        .set(operator.auth)
        .send({ status: 'CANCELLED' })
        .expect(422);
      expect(
        await prisma.auditLog.count({
          where: { entityId: ok.id, action: 'booking.status' },
        }),
      ).toBe(1);
    });

    it('lists with filters and searches by reference, name, email and document', async () => {
      const dep = await fx.departure();
      const email = `buscar-${rand()}@example.com`;
      const { id, reference } = await webBooking(dep.id, {
        customer: customerInput({
          email,
          firstName: 'Zoraida',
          lastName: 'Quispe',
          idDocNumber: '45678912',
          locale: LOCALE,
        }),
      });
      const list = async (q: Body) => {
        const res = await http()
          .get('/api/bookings')
          .query(q)
          .set(operator.auth)
          .expect(200);
        return res.body as { data: Body[]; meta: Body };
      };
      for (const q of [
        reference.toLowerCase(),
        email,
        'zoraida',
        'QUISPE',
        '45678912',
      ]) {
        const found = await list({ q });
        expect(found.data.map((b) => b.id)).toContain(id);
      }
      const byDep = await list({ departureId: dep.id });
      expect(byDep.data).toHaveLength(1);
      expect(byDep.data[0]).toMatchObject({
        reference,
        customerName: 'Zoraida Quispe',
        tourSlug: fx.tour.slug,
        source: 'WEB',
      });
      expect(
        (await list({ departureId: dep.id, status: 'CONFIRMED' })).data,
      ).toHaveLength(0);
      expect(
        (
          await list({
            tourRefId: fx.tour.id,
            from: dep.startsAt.toISOString(),
            to: new Date(dep.startsAt.getTime() + 1000).toISOString(),
          })
        ).data.length,
      ).toBeGreaterThan(0);
      const paged = await list({ tourRefId: fx.tour.id, pageSize: 2 });
      expect(paged.data.length).toBeLessThanOrEqual(2);
      expect(paged.meta).toMatchObject({ page: 1, pageSize: 2 });
      await http()
        .get('/api/bookings')
        .query({ pageSize: 1000 })
        .set(operator.auth)
        .expect(422);
    });

    it('shows the full booking and 404 for unknown ids', async () => {
      const dep = await fx.departure();
      const { id } = await webBooking(dep.id);
      const res = await http()
        .get(`/api/bookings/${id}`)
        .set(operator.auth)
        .expect(200);
      const b = res.body as Body;
      expect(b).toMatchObject({
        id,
        refundDueCents: 0,
        billing: { docType: 'BOLETA' },
      });
      expect(b.waivers.length).toBe(2);
      await http()
        .get('/api/bookings/00000000-0000-4000-8000-000000000000')
        .set(operator.auth)
        .expect(404);
    });

    it('edits notes, billing, contact and passengers, with audit', async () => {
      const dep = await fx.departure();
      const { id } = await webBooking(dep.id, {
        adults: 2,
        passengers: [{ firstName: 'A', lastName: 'B' }],
      });
      const res = await http()
        .patch(`/api/bookings/${id}`)
        .set(operator.auth)
        .send({
          notes: 'Llega tarde',
          billing: { ...billingBoleta, name: 'Otro Nombre' },
          customer: customerInput({
            firstName: 'Ana María',
            phone: '+51911111111',
          }),
          passengers: [
            { firstName: 'Ana', lastName: 'Pérez' },
            {
              firstName: 'Luis',
              lastName: 'Pérez',
              emergencyContactPhone: '+5199',
            },
          ],
        })
        .expect(200);
      const b = res.body as Body;
      expect(b).toMatchObject({
        notes: 'Llega tarde',
        billing: { name: 'Otro Nombre' },
        customer: { firstName: 'Ana María' },
      });
      expect(b.passengers).toHaveLength(2);
      expect(b.waivers.map((w: Body) => w.passengerId).sort()).toEqual(
        b.passengers.map((p: Body) => p.id).sort(),
      );
      expect(
        await prisma.auditLog.count({
          where: { entityId: id, action: 'booking.update' },
        }),
      ).toBe(1);

      await http()
        .patch(`/api/bookings/${id}`)
        .set(operator.auth)
        .send({ billing: { ...billingBoleta, idDocNumber: '1' } })
        .expect(422);
      await http()
        .patch(`/api/bookings/${id}`)
        .set(operator.auth)
        .send({
          passengers: [1, 2, 3].map((i) => ({
            firstName: `P${i}`,
            lastName: 'X',
          })),
        })
        .expect(422);
      await http()
        .post(`/api/bookings/${id}/cancel`)
        .set(operator.auth)
        .send({ reason: 'x', refund: 'POLICY' })
        .expect(200);
      await http()
        .patch(`/api/bookings/${id}`)
        .set(operator.auth)
        .send({ notes: 'tarde' })
        .expect(409);
    });

    it('lists, shows and edits customers with their history', async () => {
      const dep = await fx.departure();
      const email = `hist-${rand()}@example.com`;
      const input = customerInput({
        email,
        firstName: 'Rosa',
        lastName: 'Huamán',
        locale: LOCALE,
      });
      await webBooking(dep.id, { customer: input, adults: 1 });
      await webBooking(dep.id, { customer: input, adults: 1 });
      const other = await webBooking(dep.id, {
        customer: { ...input, firstName: 'Pedro' },
        adults: 1,
      });

      const list = await http()
        .get('/api/customers')
        .query({ q: email })
        .set(operator.auth)
        .expect(200);
      const customers = (list.body as { data: Body[] }).data;
      expect(customers).toHaveLength(2); // Rosa (reutilizada) y Pedro
      const rosa = customers.find((c) => c.firstName === 'Rosa')!;
      const detail = await http()
        .get(`/api/customers/${rosa.id}`)
        .set(operator.auth)
        .expect(200);
      expect((detail.body as Body).bookings).toHaveLength(2);
      expect(other.reference).toBeDefined();

      const edited = await http()
        .patch(`/api/customers/${rosa.id}`)
        .set(operator.auth)
        .send({ ...input, phone: '+51900000000', firstName: 'Rosa Elena' })
        .expect(200);
      expect(edited.body as Body).toMatchObject({
        phone: '+51900000000',
        firstName: 'Rosa Elena',
      });
      await http()
        .get('/api/customers/00000000-0000-4000-8000-000000000000')
        .set(operator.auth)
        .expect(404);
      await http().get('/api/customers').expect(401);
    });
  });

  // ---------------------------------------------------------- Vencimientos
  describe('expiry sweep', () => {
    let fx: CatalogFixture;
    let expiry: ExpiryService;
    beforeAll(async () => {
      fx = await createCatalog(app);
      expiry = app.get(ExpiryService);
    });

    const later = new Date(Date.now() + 3 * HOUR);

    it('cancels unpaid web bookings whose payment window passed and frees the seats', async () => {
      const dep = await fx.departure({ capacity: 2 });
      const unpaid = await webBooking(dep.id);
      await hold(dep.id, 1).expect(409);

      const before = await expiry.runOnce(new Date());
      expect(before.bookings).toBeGreaterThanOrEqual(0);
      expect(
        (await prisma.booking.findUniqueOrThrow({ where: { id: unpaid.id } }))
          .status,
      ).toBe('PENDING_PAYMENT');

      await expiry.runOnce(later);
      const row = await prisma.booking.findUniqueOrThrow({
        where: { id: unpaid.id },
        include: { hold: true },
      });
      expect(row).toMatchObject({
        status: 'CANCELLED',
        cancelReason: 'payment_timeout',
      });
      expect(row.hold?.releasedAt).not.toBeNull();
      await hold(dep.id, 2).expect(201);
      expect(
        await prisma.auditLog.count({
          where: { entityId: unpaid.id, action: 'booking.expire' },
        }),
      ).toBe(1);
      expect(
        mailer.sent.some(
          (m) =>
            m.template === 'booking_expired' &&
            (m.data as Body).reference === unpaid.reference,
        ),
      ).toBe(true);
    });

    it('leaves paid and manual bookings alone and releases orphan holds', async () => {
      const dep = await fx.departure();
      const paid = await webBooking(dep.id);
      await http()
        .post(`/api/bookings/${paid.id}/payments/manual`)
        .set(operator.auth)
        .send({
          method: 'CASH',
          kind: 'FULL',
          amountCents: 20000,
          currency: 'USD',
        })
        .expect(201);
      const manual = await http()
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
      const orphan = await hold(dep.id, 1).expect(201);

      await expiry.runOnce(later);
      expect(
        (await prisma.booking.findUniqueOrThrow({ where: { id: paid.id } }))
          .status,
      ).toBe('CONFIRMED');
      expect(
        (
          await prisma.booking.findUniqueOrThrow({
            where: { id: (manual.body as Body).id },
          })
        ).status,
      ).toBe('PENDING_PAYMENT');
      const h = await prisma.hold.findUniqueOrThrow({
        where: { token: (orphan.body as Body).token },
      });
      expect(h.releasedAt).not.toBeNull();
    });

    it('does not expire a booking while a gateway payment is in flight', async () => {
      const dep = await fx.departure();
      const b = await webBooking(dep.id);
      const inFlight = await prisma.payment.create({
        data: {
          bookingId: b.id,
          provider: 'CULQI',
          method: 'CARD',
          kind: 'FULL',
          status: 'REQUIRES_ACTION',
          currency: 'USD',
          amountCents: 20000,
        },
      });
      // El pago se actualizó "hace un momento" respecto del instante simulado del barrido.
      const sweepAt = new Date(Date.now() + 31 * 60_000);
      await prisma.$executeRaw`UPDATE "Payment" SET "updatedAt" = ${new Date(sweepAt.getTime() - 60_000)} WHERE "id" = ${inFlight.id}`;
      await expiry.runOnce(sweepAt);
      expect(
        (await prisma.booking.findUniqueOrThrow({ where: { id: b.id } }))
          .status,
      ).toBe('PENDING_PAYMENT');
    });

    it('two sweeps at once do not double-process', async () => {
      const dep = await fx.departure();
      const b = await webBooking(dep.id);
      await Promise.all([expiry.runOnce(later), expiry.runOnce(later)]);
      expect(
        await prisma.auditLog.count({
          where: { entityId: b.id, action: 'booking.expire' },
        }),
      ).toBe(1);
    });
  });
});
