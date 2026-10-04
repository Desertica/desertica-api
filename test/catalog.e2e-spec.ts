import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { CmsClient, CmsTour } from '../src/modules/cms/cms.client';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp, loginAs, TestSession } from './helpers';

const run = Math.random().toString(36).slice(2, 8);
const slugA = `tour-a-${run}`;
const slugB = `tour-b-${run}`;
let cmsTours: CmsTour[] = [
  { slug: slugA, title: 'Tour A', durationHours: 2 },
  { slug: slugB, title: 'Tour B', durationHours: null },
];

type Body = Record<string, any>;

describe('Catálogo (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let admin: TestSession;
  let operator: TestSession;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await createTestApp((b) =>
      b
        .overrideProvider(CmsClient)
        .useValue({ listTours: () => Promise.resolve(cmsTours) }),
    );
    prisma = app.get(PrismaService);
    admin = await loginAs(app, 'admin');
    operator = await loginAs(app, 'operator');
  });
  afterAll(async () => {
    await app.close();
  });

  let tourA: Body;

  it('syncs tours from the CMS without touching operational settings', async () => {
    const first = await http()
      .post('/api/tour-refs/sync')
      .set(admin.auth)
      .expect(200);
    expect((first.body as Body).created).toBeGreaterThanOrEqual(2);

    // La tabla acumula tours de otras pruebas: se pagina hasta encontrarlo.
    for (let page = 1; !tourA; page++) {
      const list = await http()
        .get('/api/tour-refs')
        .query({ pageSize: 100, page })
        .set(admin.auth)
        .expect(200);
      const rows = (list.body as { data: Body[] }).data;
      tourA = rows.find((t) => t.slug === slugA)!;
      if (rows.length === 0) break;
    }
    expect(tourA).toMatchObject({
      title: 'Tour A',
      durationHours: 2,
      active: true,
    });

    await http()
      .patch(`/api/tour-refs/${tourA.id}`)
      .set(admin.auth)
      .send({ defaultCapacity: 8, minAge: 12, requiresWaiver: false })
      .expect(200);

    cmsTours = [
      { slug: slugA, title: 'Tour A (nuevo título)', durationHours: 3 },
      cmsTours[1],
    ];
    const second = await http()
      .post('/api/tour-refs/sync')
      .set(admin.auth)
      .expect(200);
    expect(second.body).toMatchObject({ created: 0 });

    const after = await http()
      .get(`/api/tour-refs/${tourA.id}`)
      .set(admin.auth)
      .expect(200);
    expect(after.body).toMatchObject({
      title: 'Tour A (nuevo título)',
      durationHours: 3,
      defaultCapacity: 8,
      minAge: 12,
      requiresWaiver: false,
    });
  });

  it('only lets staff with catalog:write sync or edit tours', async () => {
    await http().post('/api/tour-refs/sync').set(operator.auth).expect(403);
    await http()
      .patch(`/api/tour-refs/${tourA.id}`)
      .set(operator.auth)
      .send({ active: true })
      .expect(403);
    await http().get('/api/tour-refs').set(operator.auth).expect(200);
  });

  describe('cancellation policies', () => {
    const key = `pol-${run}`;
    it('versions a policy and moves tours to the newest version', async () => {
      const v1 = await http()
        .post('/api/cancellation-policies')
        .set(admin.auth)
        .send({
          key,
          name: 'V1',
          tiers: [
            { hoursBefore: 0, refundPercent: 0 },
            { hoursBefore: 48, refundPercent: 100 },
          ],
        })
        .expect(201);
      const p1 = v1.body as Body;
      expect(p1.version).toBe(1);
      expect(p1.tiers[0].hoursBefore).toBe(48); // ordenados de mayor a menor

      await http()
        .patch(`/api/tour-refs/${tourA.id}`)
        .set(admin.auth)
        .send({ cancellationPolicyId: p1.id })
        .expect(200);

      const v2 = await http()
        .post('/api/cancellation-policies')
        .set(admin.auth)
        .send({
          key,
          name: 'V2',
          tiers: [
            { hoursBefore: 72, refundPercent: 100 },
            { hoursBefore: 0, refundPercent: 0 },
          ],
        })
        .expect(201);
      expect((v2.body as Body).version).toBe(2);

      const tour = await http()
        .get(`/api/tour-refs/${tourA.id}`)
        .set(admin.auth)
        .expect(200);
      expect((tour.body as Body).cancellationPolicyId).toBe(
        (v2.body as Body).id,
      );

      const list = await http()
        .get('/api/cancellation-policies')
        .set(admin.auth)
        .expect(200);
      const mine = (list.body as { data: Body[] }).data.filter(
        (p) => p.key === key,
      );
      expect(mine.map((p) => [p.version, p.active])).toEqual([
        [2, true],
        [1, false],
      ]);

      await http()
        .patch(`/api/tour-refs/${tourA.id}`)
        .set(admin.auth)
        .send({ cancellationPolicyId: p1.id })
        .expect(422); // la versión 1 ya no está activa
    });

    it('rejects tiers where the refund grows closer to departure', async () => {
      await http()
        .post('/api/cancellation-policies')
        .set(admin.auth)
        .send({
          key: `bad-${run}`,
          name: 'Bad',
          tiers: [
            { hoursBefore: 48, refundPercent: 10 },
            { hoursBefore: 24, refundPercent: 90 },
          ],
        })
        .expect(422);
    });
  });

  describe('price rules', () => {
    it('validates and manages rules', async () => {
      const base = {
        tourRefId: tourA.id,
        currency: 'USD',
        adultCents: 5000,
        childCents: 4000,
      };
      const created = await http()
        .post('/api/price-rules')
        .set(admin.auth)
        .send(base)
        .expect(201);
      const rule = created.body as Body;
      expect(rule).toMatchObject({
        format: 'SHARED',
        unit: 'PER_PERSON',
        priority: 0,
        active: true,
        validFrom: null,
      });

      await http()
        .post('/api/price-rules')
        .set(admin.auth)
        .send({ ...base, unit: 'PER_GROUP' })
        .expect(422);
      await http()
        .post('/api/price-rules')
        .set(admin.auth)
        .send({ ...base, minPeople: 5, maxPeople: 2 })
        .expect(422);
      await http()
        .post('/api/price-rules')
        .set(admin.auth)
        .send({ ...base, validFrom: '2026-12-01', validTo: '2026-01-01' })
        .expect(422);
      await http()
        .post('/api/price-rules')
        .set(admin.auth)
        .send({ ...base, adultCents: 12.5 })
        .expect(422);
      await http()
        .post('/api/price-rules')
        .set(admin.auth)
        .send({ ...base, tourRefId: '00000000-0000-4000-8000-000000000000' })
        .expect(422);

      const replaced = await http()
        .put(`/api/price-rules/${rule.id}`)
        .set(admin.auth)
        .send({
          ...base,
          adultCents: 5500,
          validFrom: '2026-01-01',
          validTo: '2040-12-31',
        })
        .expect(200);
      expect(replaced.body).toMatchObject({
        adultCents: 5500,
        validFrom: '2026-01-01',
        validTo: '2040-12-31',
      });

      await http()
        .delete(`/api/price-rules/${rule.id}`)
        .set(admin.auth)
        .expect(204);
      const list = await http()
        .get('/api/price-rules')
        .query({ tourRefId: tourA.id })
        .set(admin.auth)
        .expect(200);
      expect(
        (list.body as { data: Body[] }).data.find((r) => r.id === rule.id)
          ?.active,
      ).toBe(false);
      await http()
        .post('/api/price-rules')
        .set(operator.auth)
        .send(base)
        .expect(403);
    });
  });

  describe('departures, availability and quotes', () => {
    const month = '2031-03';
    let departure: Body;

    beforeAll(async () => {
      for (const currency of ['USD', 'PEN']) {
        await http()
          .post('/api/price-rules')
          .set(admin.auth)
          .send({
            tourRefId: tourA.id,
            currency,
            adultCents: currency === 'USD' ? 5000 : 18000,
            childCents: currency === 'USD' ? 4000 : 14000,
          })
          .expect(201);
      }
    });

    it('creates a single departure and rejects duplicates and the past', async () => {
      const res = await http()
        .post('/api/departures')
        .set(operator.auth)
        .send({
          tourRefId: tourA.id,
          startsAt: '2031-03-03T14:00:00Z',
          capacity: 6,
          meetingPoint: 'Plaza',
          cutoffMinutes: 60,
        })
        .expect(201);
      departure = (res.body as { data: Body[] }).data[0];
      expect(departure).toMatchObject({
        capacity: 6,
        seatsSold: 0,
        seatsHeld: 0,
        format: 'SHARED',
        language: 'es',
        status: 'OPEN',
      });

      const dup = await http()
        .post('/api/departures')
        .set(operator.auth)
        .send({
          tourRefId: tourA.id,
          startsAt: '2031-03-03T14:00:00Z',
          capacity: 6,
        })
        .expect(409);
      expect((dup.body as Body).details.startsAt).toEqual([
        '2031-03-03T14:00:00.000Z',
      ]);

      await http()
        .post('/api/departures')
        .set(operator.auth)
        .send({
          tourRefId: tourA.id,
          startsAt: '2020-01-01T14:00:00Z',
          capacity: 6,
        })
        .expect(422);
    });

    it('creates a series on the chosen weekdays and is atomic on conflicts', async () => {
      // 2031-03-10 es lunes. Lun/mié/vie por dos semanas = 6 salidas.
      const res = await http()
        .post('/api/departures')
        .set(admin.auth)
        .send({
          tourRefId: tourA.id,
          startsAt: '2031-03-10T14:00:00Z',
          capacity: 10,
          repeat: { until: '2031-03-21', weekdays: [1, 3, 5] },
        })
        .expect(201);
      const created = (res.body as { data: Body[] }).data;
      expect(created.map((d) => d.startsAt)).toEqual([
        '2031-03-10T14:00:00.000Z',
        '2031-03-12T14:00:00.000Z',
        '2031-03-14T14:00:00.000Z',
        '2031-03-17T14:00:00.000Z',
        '2031-03-19T14:00:00.000Z',
        '2031-03-21T14:00:00.000Z',
      ]);

      // Una fecha repetida hace fallar toda la serie y no crea nada.
      await http()
        .post('/api/departures')
        .set(admin.auth)
        .send({
          tourRefId: tourA.id,
          startsAt: '2031-03-24T14:00:00Z',
          capacity: 10,
          repeat: { until: '2031-03-28', weekdays: [1, 2] },
        })
        .expect(201);
      const clash = await http()
        .post('/api/departures')
        .set(admin.auth)
        .send({
          tourRefId: tourA.id,
          startsAt: '2031-03-24T14:00:00Z',
          capacity: 10,
          repeat: { until: '2031-03-29', weekdays: [1, 2, 3] },
        })
        .expect(409);
      expect((clash.body as Body).details.startsAt).toHaveLength(2);
      const count = await prisma.departure.count({
        where: {
          tourRefId: tourA.id as string,
          startsAt: new Date('2031-03-26T14:00:00Z'),
        },
      });
      expect(count).toBe(0);
    });

    it('lists departures with filters and paging', async () => {
      const res = await http()
        .get('/api/departures')
        .query({
          tourRefId: tourA.id,
          from: '2031-03-01T00:00:00Z',
          to: '2031-03-12T00:00:00Z',
          pageSize: 100,
        })
        .set(operator.auth)
        .expect(200);
      const body = res.body as { data: Body[]; meta: Body };
      expect(body.data.map((d) => d.startsAt)).toEqual([
        '2031-03-03T14:00:00.000Z',
        '2031-03-10T14:00:00.000Z',
      ]);
      expect(body.meta).toMatchObject({ page: 1, pageSize: 100, total: 2 });
    });

    it('serves public availability with prices, hiding what cannot be sold', async () => {
      const res = await http()
        .get(`/api/public/tours/${slugA}/availability`)
        .query({ month, currency: 'USD' })
        .expect(200);
      const data = (res.body as { data: Body[] }).data;
      const first = data.find((d) => d.departureId === departure.id)!;
      expect(first).toMatchObject({
        seatsLeft: 6,
        meetingPoint: 'Plaza',
        price: {
          currency: 'USD',
          unit: 'PER_PERSON',
          adultCents: 5000,
          childCents: 4000,
        },
      });

      // Sin reglas en esa moneda no se vende.
      await prisma.priceRule.updateMany({
        where: { tourRefId: tourA.id as string, currency: 'PEN' },
        data: { active: false },
      });
      const pen = await http()
        .get(`/api/public/tours/${slugA}/availability`)
        .query({ month, currency: 'PEN' })
        .expect(200);
      expect((pen.body as { data: Body[] }).data).toEqual([]);

      // Filtros de formato e idioma.
      const priv = await http()
        .get(`/api/public/tours/${slugA}/availability`)
        .query({ month, currency: 'USD', format: 'PRIVATE' })
        .expect(200);
      expect((priv.body as { data: Body[] }).data).toEqual([]);

      await http()
        .get('/api/public/tours/nope/availability')
        .query({ month, currency: 'USD' })
        .expect(404);
      await http()
        .get(`/api/public/tours/${slugA}/availability`)
        .query({ month: '2031-13', currency: 'USD' })
        .expect(422);
      await http()
        .get(`/api/public/tours/${slugA}/availability`)
        .query({ month, currency: 'EUR' })
        .expect(422);
    });

    it('hides closed departures and blackout dates', async () => {
      const closed = await http()
        .post('/api/departures')
        .set(admin.auth)
        .send({
          tourRefId: tourA.id,
          startsAt: '2031-03-04T14:00:00Z',
          capacity: 4,
        })
        .expect(201);
      const closedId = (closed.body as { data: Body[] }).data[0].id as string;
      await http()
        .patch(`/api/departures/${closedId}`)
        .set(admin.auth)
        .send({ status: 'CLOSED' })
        .expect(200);

      const bo = await http()
        .post('/api/blackouts')
        .set(admin.auth)
        .send({
          tourRefId: tourA.id,
          startsOn: '2031-03-03',
          endsOn: '2031-03-03',
          reason: 'Mantenimiento',
        })
        .expect(201);

      const res = await http()
        .get(`/api/public/tours/${slugA}/availability`)
        .query({ month, currency: 'USD' })
        .expect(200);
      const ids = (res.body as { data: Body[] }).data.map((d) => d.departureId);
      expect(ids).not.toContain(closedId);
      expect(ids).not.toContain(departure.id);

      await http()
        .post('/api/blackouts')
        .set(admin.auth)
        .send({ startsOn: '2031-03-05', endsOn: '2031-03-01' })
        .expect(422);
      await http()
        .delete(`/api/blackouts/${(bo.body as Body).id}`)
        .set(admin.auth)
        .expect(204);
      const list = await http()
        .get('/api/blackouts')
        .set(operator.auth)
        .expect(200);
      expect(
        (list.body as { data: Body[] }).data.find(
          (b) => b.id === (bo.body as Body).id,
        ),
      ).toBeUndefined();
    });

    it('quotes totals, deposit and cancellation tiers', async () => {
      const res = await http()
        .post('/api/public/quotes')
        .send({
          departureId: departure.id,
          adults: 2,
          children: 1,
          currency: 'USD',
        })
        .expect(200);
      expect(res.body).toMatchObject({
        currency: 'USD',
        totalCents: 14000,
        depositCents: 4200, // 30 % por defecto
        lines: [
          { label: 'adult', quantity: 2, unitCents: 5000, totalCents: 10000 },
          { label: 'child', quantity: 1, unitCents: 4000, totalCents: 4000 },
        ],
        cancellationTiers: [
          { hoursBefore: 72, refundPercent: 100 },
          { hoursBefore: 0, refundPercent: 0 },
        ],
      });
    });

    it('rejects quotes that cannot be sold', async () => {
      const q = (over: Body) =>
        http()
          .post('/api/public/quotes')
          .send({
            departureId: departure.id,
            adults: 1,
            currency: 'USD',
            ...over,
          });
      await q({ adults: 7 }).expect(422); // capacidad 6
      await q({ currency: 'PEN' }).expect(422); // sin precio activo en PEN
      await q({ departureId: '00000000-0000-4000-8000-000000000000' }).expect(
        422,
      );
      await q({ adults: 0 }).expect(422);
    });

    it('counts sold seats in quotes, listings and capacity changes', async () => {
      const customer = await prisma.customer.create({
        data: {
          email: `c-${run}@example.com`,
          firstName: 'Ana',
          lastName: 'Pérez',
        },
      });
      await prisma.booking.create({
        data: {
          reference: `T-${run}`.toUpperCase(),
          status: 'CONFIRMED',
          departureId: departure.id as string,
          customerId: customer.id,
          currency: 'USD',
          adults: 3,
          children: 1,
          totalCents: 19000,
          paidCents: 19000,
          priceSnapshot: {},
          cancellationSnapshot: {},
          billing: {},
        },
      });
      const got = await http()
        .get(`/api/departures/${departure.id}`)
        .set(operator.auth)
        .expect(200);
      expect((got.body as Body).seatsSold).toBe(4);

      await http()
        .post('/api/public/quotes')
        .send({ departureId: departure.id, adults: 3, currency: 'USD' })
        .expect(422);
      await http()
        .patch(`/api/departures/${departure.id}`)
        .set(admin.auth)
        .send({ capacity: 3 })
        .expect(409);
      await http()
        .patch(`/api/departures/${departure.id}`)
        .set(admin.auth)
        .send({ capacity: 4 })
        .expect(200);

      const manifest = await http()
        .get(`/api/departures/${departure.id}/manifest`)
        .set(operator.auth)
        .expect(200);
      const m = manifest.body as { passengers: Body[] };
      expect(m.passengers).toHaveLength(1);
      expect(m.passengers[0]).toMatchObject({
        name: 'Ana Pérez',
        waiverStatus: 'PENDING',
        balanceDueCents: 0,
        currency: 'USD',
      });
    });
  });

  describe('settings', () => {
    it('returns defaults, validates and persists', async () => {
      const res = await http().get('/api/settings').set(admin.auth).expect(200);
      expect((res.body as Body).depositPercent).toBeDefined();
      await http()
        .put('/api/settings')
        .set(admin.auth)
        .send({ depositPercent: 150 })
        .expect(422);
      await http()
        .put('/api/settings')
        .set(admin.auth)
        .send({ depositPercent: 40 })
        .expect(200);
      const after = await http()
        .get('/api/settings')
        .set(operator.auth)
        .expect(403);
      expect((after.body as Body).statusCode).toBe(403);
      await http()
        .put('/api/settings')
        .set(admin.auth)
        .send({ depositPercent: 30 })
        .expect(200);
    });

    it('accepts extra flat keys but not nested values, odd keys or floods', async () => {
      const put = (body: Body) =>
        http().put('/api/settings').set(admin.auth).send(body);
      const ok = await put({ supportPhone: '+51 999 000 111' }).expect(200);
      expect((ok.body as Body).supportPhone).toBe('+51 999 000 111');
      await put({ nested: { a: 1 } }).expect(422);
      await put({ list: [1] }).expect(422);
      await put({ 'bad key!': 1 }).expect(422);
      await put({ long: 'x'.repeat(2001) }).expect(422);
      await put({ depositPercent: 12.5 }).expect(422);
      await put({ holdMinutes: 0 }).expect(422);
      await put(
        Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`k${i}`, i])),
      ).expect(422);
    });
  });
});
