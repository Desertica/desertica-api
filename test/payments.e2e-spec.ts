import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { BookingAccessService } from '../src/modules/bookings/booking-access.service';
import { ExpiryService } from '../src/modules/bookings/expiry.service';
import { GatewayRegistry } from '../src/modules/payments/gateway.registry';
import {
  FakeGateway,
  signFakeEvent,
} from '../src/modules/payments/providers/fake.gateway';
import type { GatewayEvent } from '../src/modules/payments/providers/payment-gateway';
import { StaffAlertsService } from '../src/modules/payments/staff-alerts.service';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  billingBoleta,
  CatalogFixture,
  createCatalog,
  customerInput,
  rand,
} from './fixtures';
import { createTestApp, loginAs, TestSession } from './helpers';

type Body = Record<string, any>;

const locale = () => {
  const l = 'abcdefghijklmnopqrstuvwxyz';
  const p = () => l[Math.floor(Math.random() * 26)];
  return `q${p()}-${p()}${p()}`.replace(
    /-(..)/,
    (_m, x: string) => `-${x.toUpperCase()}`,
  );
};

describe('Pagos por pasarela (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let admin: TestSession;
  let stripe: FakeGateway;
  let fx: CatalogFixture;
  const LOCALE = locale();
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await createTestApp((b) =>
      b.overrideProvider(StaffAlertsService).useValue({
        alert: (code: string, data: Body, o: { bookingId?: string } = {}) => {
          alertLog.push({ code, bookingId: o.bookingId });
          return Promise.resolve();
        },
      }),
    );
    prisma = app.get(PrismaService);
    const registry = app.get(GatewayRegistry);
    stripe = registry.get('STRIPE') as FakeGateway;
    admin = await loginAs(app, 'admin');
    fx = await createCatalog(app);
  });
  afterAll(async () => {
    await app.close();
  });

  /**
   * Reserva creada directo en la base (con su token de "mi reserva"): las pruebas
   * de pagos no dependen de que `POST /public/bookings` ya cumpla el contrato.
   */
  async function webBooking(
    over: Body = {},
    departureId?: string,
  ): Promise<{ id: string; reference: string; token: string; total: number }> {
    const dep = departureId ?? (await fx.departure({ capacity: 10 })).id;
    const departure = await prisma.departure.findUniqueOrThrow({
      where: { id: dep },
    });
    const adults = over.adults ?? 2;
    const currency = over.currency ?? 'USD';
    const total = currency === 'USD' ? adults * 10000 : adults * 36000;
    const hold = await prisma.hold.create({
      data: {
        token: `h-${rand()}${rand()}${rand()}`,
        departureId: dep,
        seats: adults,
        expiresAt: new Date(Date.now() + 30 * 60_000),
      },
    });
    const customer = await prisma.customer.create({
      data: { ...customerInput({ locale: LOCALE }), idDocType: 'DNI' },
    });
    const row = await prisma.booking.create({
      data: {
        reference: `DST-${rand().toUpperCase()}${rand().toUpperCase()}`.slice(
          0,
          10,
        ),
        status: 'PENDING_PAYMENT',
        source: 'WEB',
        departureId: dep,
        customerId: customer.id,
        holdId: hold.id,
        currency,
        adults,
        totalCents: total,
        depositCents:
          over.paymentKind === 'DEPOSIT' ? Math.round(total * 0.3) : null,
        priceSnapshot: {},
        cancellationSnapshot: { tiers: [] },
        billing: billingBoleta,
      },
    });
    const token = await app
      .get(BookingAccessService)
      .issue(prisma, row.id, departure.startsAt);
    return { id: row.id, reference: row.reference, token, total };
  }

  const stripeIntent = (
    b: { reference: string; token: string },
    kind = 'FULL',
    key?: string,
  ) => {
    const r = http()
      .post(`/api/public/bookings/${b.reference}/payments/stripe-intent`)
      .set('X-Booking-Token', b.token);
    if (key) r.set('Idempotency-Key', key);
    return r.send({ kind });
  };

  const culqiCharge = (
    b: { reference: string; token: string },
    token: string,
    over: Body = {},
  ) =>
    http()
      .post(`/api/public/bookings/${b.reference}/payments/culqi-charge`)
      .set('X-Booking-Token', b.token)
      .send({ kind: 'FULL', token, email: 'ana@example.com', ...over });

  const gwPayment = (p: Body, over: Body = {}) => ({
    providerRef: p.providerRef,
    status: 'SUCCEEDED',
    amountCents: p.amountCents,
    currency: p.currency,
    metadata: { paymentId: p.id },
    ...over,
  });

  const webhook = (
    provider: 'stripe' | 'culqi',
    event: GatewayEvent,
    tamper = false,
  ) => {
    const signed = signFakeEvent(event);
    return http()
      .post(`/api/webhooks/${provider}`)
      .set({
        ...signed.headers,
        ...(tamper ? { 'x-fake-signature': 'deadbeef' } : {}),
      })
      .send(signed.body);
  };

  const succeeded = (
    provider: 'stripe' | 'culqi',
    p: Body,
    eventId = `evt_${rand()}${rand()}`,
    over: Body = {},
  ) =>
    webhook(provider, {
      kind: 'payment',
      eventId,
      type: 'payment_intent.succeeded',
      payment: gwPayment(p, over),
    } as GatewayEvent);

  const payment = (id: string) =>
    prisma.payment.findUniqueOrThrow({ where: { id } });
  const booking = (id: string) =>
    prisma.booking.findUniqueOrThrow({ where: { id } });
  const alertLog: { code: string; bookingId?: string }[] = [];
  const alerts = (bookingId: string, code?: string) =>
    Promise.resolve(
      alertLog.filter(
        (a) => a.bookingId === bookingId && (!code || a.code === code),
      ).length,
    );

  // ------------------------------------------------------------- Stripe
  describe('Stripe', () => {
    it('creates an intent from the booking and confirms it only through the webhook', async () => {
      const b = await webBooking();
      const res = await stripeIntent(b).expect(201);
      const intent = res.body as Body;
      expect(intent).toMatchObject({
        amountCents: b.total,
        currency: 'USD',
        publishableKey: 'pk_fake_stripe',
      });
      expect(intent.clientSecret).toContain('_secret_');

      const row = await payment(intent.paymentId);
      expect(row).toMatchObject({ status: 'PENDING', provider: 'STRIPE' });
      expect((await booking(b.id)).status).toBe('PENDING_PAYMENT');

      await succeeded('stripe', row).expect(200);
      expect((await payment(row.id)).status).toBe('SUCCEEDED');
      expect(await booking(b.id)).toMatchObject({
        status: 'CONFIRMED',
        paidCents: b.total,
      });
      const audit = await prisma.auditLog.findMany({
        where: { entity: 'Payment', entityId: row.id },
      });
      expect(audit.map((a) => a.action)).toEqual(
        expect.arrayContaining(['payment.start', 'payment.succeeded']),
      );
    });

    it('rejects a PEN booking, a bad token and an unknown kind', async () => {
      const pen = await webBooking({ currency: 'PEN' });
      await stripeIntent(pen).expect(422);
      const b = await webBooking();
      await http()
        .post(`/api/public/bookings/${b.reference}/payments/stripe-intent`)
        .set('X-Booking-Token', 'nope')
        .send({ kind: 'FULL' })
        .expect(401);
      await stripeIntent(b, 'WHATEVER').expect(422);
      await stripeIntent(b, 'DEPOSIT').expect(422); // sin depósito
      await stripeIntent(b, 'BALANCE').expect(422);
    });

    it('does not create a second intent when the request is repeated with the same key', async () => {
      const b = await webBooking();
      const key = `k-${rand()}${rand()}`;
      const before = stripe.createCalls;
      const a = await stripeIntent(b, 'FULL', key).expect(201);
      const again = await stripeIntent(b, 'FULL', key).expect(201);
      expect(stripe.createCalls).toBe(before + 1);
      expect((again.body as Body).paymentId).toBe((a.body as Body).paymentId);
      expect(await prisma.payment.count({ where: { bookingId: b.id } })).toBe(
        1,
      );
    });

    it('a duplicate webhook does not duplicate the payment', async () => {
      const b = await webBooking();
      const p = await payment(
        ((await stripeIntent(b).expect(201)).body as Body).paymentId,
      );
      const id = `evt_dup_${rand()}${rand()}`;
      await succeeded('stripe', p, id).expect(200);
      await succeeded('stripe', p, id).expect(200);
      // Otro evento (id distinto) sobre el mismo cobro tampoco acredita dos veces.
      await succeeded('stripe', p).expect(200);
      expect((await booking(b.id)).paidCents).toBe(b.total);
      expect(
        await prisma.webhookEvent.count({
          where: { provider: 'STRIPE', eventId: id },
        }),
      ).toBe(1);
    });

    it('answers 400 to an invalid signature and stores nothing', async () => {
      const b = await webBooking();
      const p = await payment(
        ((await stripeIntent(b).expect(201)).body as Body).paymentId,
      );
      const eventId = `evt_bad_${rand()}${rand()}`;
      await webhook(
        'stripe',
        {
          kind: 'payment',
          eventId,
          type: 'payment_intent.succeeded',
          payment: gwPayment(p),
        } as GatewayEvent,
        true,
      ).expect(400);
      await http()
        .post('/api/webhooks/stripe')
        .set('content-type', 'application/json')
        .send('{"kind":"ignored"}')
        .expect(400);
      expect(await prisma.webhookEvent.count({ where: { eventId } })).toBe(0);
      expect((await payment(p.id)).status).toBe('PENDING');
    });

    it('records a failed payment and ignores a stale failure after success', async () => {
      const b = await webBooking();
      const p = await payment(
        ((await stripeIntent(b).expect(201)).body as Body).paymentId,
      );
      await webhook('stripe', {
        kind: 'payment',
        eventId: `evt_${rand()}${rand()}`,
        type: 'payment_intent.payment_failed',
        payment: gwPayment(p, {
          status: 'FAILED',
          failureCode: 'card_declined',
        }),
      } as GatewayEvent).expect(200);
      expect(await payment(p.id)).toMatchObject({
        status: 'FAILED',
        failureCode: 'card_declined',
      });
      expect((await booking(b.id)).status).toBe('PENDING_PAYMENT');

      // El cliente reintenta y esta vez paga: el éxito gana.
      const retry = await payment(
        ((await stripeIntent(b).expect(201)).body as Body).paymentId,
      );
      await succeeded('stripe', retry).expect(200);
      // Un fallo tardío del primer intento no revierte nada.
      await webhook('stripe', {
        kind: 'payment',
        eventId: `evt_${rand()}${rand()}`,
        type: 'payment_intent.payment_failed',
        payment: gwPayment(retry, { status: 'FAILED' }),
      } as GatewayEvent).expect(200);
      expect((await payment(retry.id)).status).toBe('SUCCEEDED');
      expect((await booking(b.id)).status).toBe('CONFIRMED');
    });

    it('rejects an amount or currency that does not match what was requested', async () => {
      const b = await webBooking();
      const p = await payment(
        ((await stripeIntent(b).expect(201)).body as Body).paymentId,
      );
      await succeeded('stripe', p, undefined, { amountCents: 100 }).expect(200);
      expect(await payment(p.id)).toMatchObject({
        status: 'FAILED',
        failureCode: 'amount_mismatch',
      });
      expect(await booking(b.id)).toMatchObject({
        status: 'PENDING_PAYMENT',
        paidCents: 0,
      });
      expect(await alerts(b.id)).toBeGreaterThan(0);

      const other = await webBooking();
      const p2 = await payment(
        ((await stripeIntent(other).expect(201)).body as Body).paymentId,
      );
      await succeeded('stripe', p2, undefined, { currency: 'PEN' }).expect(200);
      expect((await payment(p2.id)).failureCode).toBe('amount_mismatch');
      expect((await booking(other.id)).paidCents).toBe(0);
      const event = await prisma.webhookEvent.findFirst({
        where: { error: 'amount_mismatch', provider: 'STRIPE' },
      });
      expect(event?.processedAt).not.toBeNull();
    });

    it('ignores events for payments that are not ours', async () => {
      const eventId = `evt_unk_${rand()}${rand()}`;
      await succeeded(
        'stripe',
        {
          providerRef: `pi_${rand()}`,
          amountCents: 5,
          currency: 'USD',
          id: '',
        },
        eventId,
        { metadata: {} },
      ).expect(200);
      const row = await prisma.webhookEvent.findFirstOrThrow({
        where: { provider: 'STRIPE', eventId },
      });
      expect(row.error).toBe('unknown_payment');
    });
  });

  // -------------------------------------------------- Depósito y saldo
  describe('deposit and balance', () => {
    it('charges the deposit, confirms, then charges the balance', async () => {
      const b = await webBooking({ paymentKind: 'DEPOSIT' });
      const row = await prisma.booking.findUniqueOrThrow({
        where: { id: b.id },
      });
      expect(row.depositCents).toBeGreaterThan(0);

      await stripeIntent(b, 'BALANCE').expect(409); // el depósito aún no se pagó
      const dep = await payment(
        ((await stripeIntent(b, 'DEPOSIT').expect(201)).body as Body).paymentId,
      );
      expect(dep).toMatchObject({
        kind: 'DEPOSIT',
        amountCents: row.depositCents,
      });
      await succeeded('stripe', dep).expect(200);
      expect(await booking(b.id)).toMatchObject({
        status: 'CONFIRMED',
        paidCents: row.depositCents,
      });
      await stripeIntent(b, 'DEPOSIT').expect(409); // ya no queda depósito

      const bal = await payment(
        ((await stripeIntent(b, 'BALANCE').expect(201)).body as Body).paymentId,
      );
      expect(bal.amountCents).toBe(b.total - row.depositCents!);
      await succeeded('stripe', bal).expect(200);
      expect((await booking(b.id)).paidCents).toBe(b.total);
      await stripeIntent(b, 'FULL').expect(409); // nada pendiente
    });
  });

  // -------------------------------------------------------------- Culqi
  describe('Culqi', () => {
    it('charges PEN with a token and confirms from the server-side result', async () => {
      const b = await webBooking({ currency: 'PEN' });
      const res = await culqiCharge(b, 'tok_ok').expect(201);
      expect(res.body).toMatchObject({ status: 'SUCCEEDED' });
      expect(await booking(b.id)).toMatchObject({
        status: 'CONFIRMED',
        paidCents: b.total,
      });
      const p = await payment((res.body as Body).paymentId);
      expect(p).toMatchObject({ provider: 'CULQI', currency: 'PEN' });
      // El webhook posterior del mismo cargo no cambia nada.
      await webhook('culqi', {
        kind: 'payment',
        eventId: `evt_${rand()}${rand()}`,
        type: 'charge.creation.succeeded',
        payment: gwPayment(p),
      } as GatewayEvent).expect(200);
      expect((await booking(b.id)).paidCents).toBe(b.total);
    });

    it('also charges USD, and reports a declined card without confirming', async () => {
      const b = await webBooking();
      const declined = await culqiCharge(b, 'tok_declined').expect(201);
      expect(declined.body).toMatchObject({ status: 'FAILED' });
      expect((declined.body as Body).failureMessage).toBeTruthy();
      expect((await booking(b.id)).status).toBe('PENDING_PAYMENT');
      const ok = await culqiCharge(b, 'tok_ok').expect(201);
      expect(ok.body).toMatchObject({ status: 'SUCCEEDED' });
      expect((await booking(b.id)).status).toBe('CONFIRMED');
    });

    it('asks for 3DS and completes after the browser authenticates', async () => {
      const b = await webBooking({ currency: 'PEN' });
      const first = await culqiCharge(b, 'tok_3ds').expect(201);
      expect(first.body).toMatchObject({
        status: 'REQUIRES_ACTION',
        action: { type: 'THREE_DS' },
      });
      expect((await booking(b.id)).status).toBe('PENDING_PAYMENT');
      const paymentId = (first.body as Body).paymentId as string;

      // Sin la autenticación no avanza.
      const stuck = await culqiCharge(b, 'tok_3ds', { paymentId }).expect(201);
      expect((stuck.body as Body).status).toBe('REQUIRES_ACTION');

      const done = await culqiCharge(b, 'tok_3ds', {
        paymentId,
        authentication3DS: { eci: '05', xid: 'x', cavv: 'c' },
      }).expect(201);
      expect(done.body).toMatchObject({ paymentId, status: 'SUCCEEDED' });
      expect((await booking(b.id)).status).toBe('CONFIRMED');
      expect(await prisma.payment.count({ where: { bookingId: b.id } })).toBe(
        1,
      );
    });

    it('leaves an unresolved charge pending until the webhook arrives', async () => {
      const b = await webBooking({ currency: 'PEN' });
      const res = await culqiCharge(b, 'tok_pending').expect(201);
      expect(res.body).toMatchObject({ status: 'PENDING' });
      const p = await payment((res.body as Body).paymentId);
      expect((await booking(b.id)).status).toBe('PENDING_PAYMENT');
      await webhook('culqi', {
        kind: 'payment',
        eventId: `evt_${rand()}${rand()}`,
        type: 'charge.creation.succeeded',
        payment: gwPayment(p),
      } as GatewayEvent).expect(200);
      expect((await booking(b.id)).status).toBe('CONFIRMED');
    });

    it('rejects a bad signature and a tampered body', async () => {
      const b = await webBooking({ currency: 'PEN' });
      const res = await culqiCharge(b, 'tok_pending').expect(201);
      const p = await payment((res.body as Body).paymentId);
      await webhook(
        'culqi',
        {
          kind: 'payment',
          eventId: `evt_${rand()}${rand()}`,
          type: 'x',
          payment: gwPayment(p),
        } as GatewayEvent,
        true,
      ).expect(400);
      expect((await payment(p.id)).status).toBe('PENDING');
    });
  });

  // ------------------------------------------------------ Enlaces de pago
  describe('payment links', () => {
    it('a link is used once and a second payment is refused', async () => {
      const b = await webBooking({ paymentKind: 'DEPOSIT' });
      await succeeded(
        'stripe',
        await payment(
          ((await stripeIntent(b, 'DEPOSIT').expect(201)).body as Body)
            .paymentId,
        ),
      ).expect(200);

      const created = await http()
        .post(`/api/bookings/${b.id}/payment-links`)
        .set(admin.auth)
        .send({ kind: 'BALANCE' })
        .expect(201);
      const link = created.body as Body;

      const intent = await http()
        .post(`/api/public/payment-links/${link.token}/stripe-intent`)
        .expect(201);
      // Mientras hay un cobro en curso no se abre otro.
      await http()
        .post(`/api/public/payment-links/${link.token}/stripe-intent`)
        .expect(409);
      const p = await payment((intent.body as Body).paymentId);
      expect(p).toMatchObject({ kind: 'BALANCE', paymentLinkId: link.id });
      await succeeded('stripe', p).expect(200);

      const used = await prisma.paymentLink.findUniqueOrThrow({
        where: { id: link.id },
      });
      expect(used.usedAt).not.toBeNull();
      expect((await booking(b.id)).paidCents).toBe(b.total);
      await http()
        .post(`/api/public/payment-links/${link.token}/stripe-intent`)
        .expect(410);
      await http()
        .post(`/api/public/payment-links/${link.token}/culqi-charge`)
        .send({ token: 'tok_ok', email: 'a@example.com' })
        .expect(410);
      await http()
        .post(`/api/public/payment-links/nope-${rand()}/stripe-intent`)
        .expect(404);
    });

    it('charges a link through Culqi', async () => {
      const b = await webBooking({ currency: 'PEN' });
      const created = await http()
        .post(`/api/bookings/${b.id}/payment-links`)
        .set(admin.auth)
        .send({ kind: 'FULL' })
        .expect(201);
      const link = created.body as Body;
      const res = await http()
        .post(`/api/public/payment-links/${link.token}/culqi-charge`)
        .send({ token: 'tok_ok', email: 'a@example.com' })
        .expect(201);
      expect(res.body).toMatchObject({ status: 'SUCCEEDED' });
      expect((await booking(b.id)).status).toBe('CONFIRMED');
      expect(
        (await prisma.paymentLink.findUniqueOrThrow({ where: { id: link.id } }))
          .usedAt,
      ).not.toBeNull();
    });
  });

  // --------------------------------------------- Pago tardío y excedentes
  describe('payment that arrives after the booking expired or was cancelled', () => {
    async function expireWithPayment(over: { capacity?: number } = {}) {
      const dep = await fx.departure({ capacity: over.capacity ?? 4 });
      const b = await webBooking({}, dep.id);
      const intent = (await stripeIntent(b).expect(201)).body as Body;
      // El cobro lleva más de la gracia en curso y la ventana de pago venció.
      await prisma.$executeRaw`UPDATE "Payment" SET "updatedAt" = now() - interval '2 hours' WHERE "id" = ${intent.paymentId}`;
      await prisma.$executeRaw`UPDATE "Hold" SET "expiresAt" = now() - interval '1 minute' WHERE "id" = (SELECT "holdId" FROM "Booking" WHERE "id" = ${b.id})`;
      await app.get(ExpiryService).runOnce();
      expect(await booking(b.id)).toMatchObject({
        status: 'CANCELLED',
        cancelReason: 'payment_timeout',
      });
      return { b, dep, payment: await payment(intent.paymentId) };
    }

    it('reactivates the booking when there is still room', async () => {
      const { b, payment: p } = await expireWithPayment();
      await succeeded('stripe', p).expect(200);
      expect(await booking(b.id)).toMatchObject({
        status: 'CONFIRMED',
        cancelledAt: null,
        cancelReason: null,
        paidCents: b.total,
      });
      expect(await prisma.refund.count({ where: { paymentId: p.id } })).toBe(0);
      expect(await alerts(b.id)).toBeGreaterThan(0);
      const audit = await prisma.auditLog.findFirst({
        where: {
          entity: 'Booking',
          entityId: b.id,
          action: 'booking.reactivate',
        },
      });
      expect(audit).not.toBeNull();
    });

    it('refunds automatically and alerts the staff when the seats are gone', async () => {
      const { b, dep, payment: p } = await expireWithPayment({ capacity: 2 });
      // Otra persona toma los dos cupos liberados.
      await webBooking({}, dep.id);

      await succeeded('stripe', p).expect(200);
      expect((await booking(b.id)).status).toBe('CANCELLED');
      const refund = await prisma.refund.findFirstOrThrow({
        where: { paymentId: p.id },
      });
      expect(refund).toMatchObject({
        amountCents: b.total,
        status: 'SUCCEEDED',
      });
      expect(refund.reason).toContain('late_payment');
      expect(stripe.refunds.map((r) => r.providerRef)).toContain(
        refund.providerRef,
      );
      expect(await payment(p.id)).toMatchObject({
        status: 'REFUNDED',
        refundedCents: b.total,
      });
      expect(await booking(b.id)).toMatchObject({
        paidCents: b.total,
        refundedCents: b.total,
      });
      expect(await alerts(b.id)).toBeGreaterThan(0);
    });

    it('never reactivates a booking that a person cancelled', async () => {
      const b = await webBooking();
      const p = await payment(
        ((await stripeIntent(b).expect(201)).body as Body).paymentId,
      );
      await prisma.booking.update({
        where: { id: b.id },
        data: {
          status: 'CANCELLED',
          cancelReason: 'cliente',
          cancelledAt: new Date(),
        },
      });
      await succeeded('stripe', p).expect(200);
      expect((await booking(b.id)).status).toBe('CANCELLED');
      expect(
        (await prisma.refund.findFirstOrThrow({ where: { paymentId: p.id } }))
          .status,
      ).toBe('SUCCEEDED');
    });

    it('queues the refund and keeps it pending when the gateway is down', async () => {
      const b = await webBooking();
      const p = await payment(
        ((await stripeIntent(b).expect(201)).body as Body).paymentId,
      );
      await prisma.booking.update({
        where: { id: b.id },
        data: {
          status: 'CANCELLED',
          cancelReason: 'cliente',
          cancelledAt: new Date(),
        },
      });
      stripe.failRefunds = true;
      try {
        await succeeded('stripe', p).expect(200);
      } finally {
        stripe.failRefunds = false;
      }
      const refund = await prisma.refund.findFirstOrThrow({
        where: { paymentId: p.id },
      });
      expect(refund.status).toBe('FAILED');
      expect(await alerts(b.id)).toBeGreaterThan(0);
    });
  });

  describe('overpayment', () => {
    it('refunds the excess when two payments cover the same booking', async () => {
      const b = await webBooking();
      const p1 = await payment(
        ((await stripeIntent(b).expect(201)).body as Body).paymentId,
      );
      const p2 = await payment(
        ((await stripeIntent(b).expect(201)).body as Body).paymentId,
      );
      await succeeded('stripe', p1).expect(200);
      await succeeded('stripe', p2).expect(200);
      expect(await booking(b.id)).toMatchObject({
        status: 'CONFIRMED',
        paidCents: b.total * 2,
        refundedCents: b.total,
      });
      expect(await payment(p2.id)).toMatchObject({ status: 'REFUNDED' });
    });
  });
});
