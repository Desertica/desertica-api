import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { StaffAlertsService } from '../src/modules/alerts/staff-alerts.service';
import {
  DOCUMENT_STORAGE,
  MemoryDocumentStorage,
} from '../src/modules/billing/document-storage';
import { DocumentsService } from '../src/modules/documents/documents.service';
import { GatewayRegistry } from '../src/modules/payments/gateway.registry';
import { FakeGateway } from '../src/modules/payments/providers/fake.gateway';
import type { GatewayEvent } from '../src/modules/payments/providers/payment-gateway';
import { RefundSweeper } from '../src/modules/payments/refund-sweeper.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { CatalogFixture, createCatalog, rand } from './fixtures';
import { createTestApp, loginAs, TestSession } from './helpers';
import {
  DirectBooking,
  ensureBilling,
  evt,
  makeBooking,
  postWebhook,
  recordPaid,
} from './payment-helpers';

type Body = Record<string, any>;

describe('Endurecimiento de pagos, reembolsos y comprobantes (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let admin: TestSession;
  let operator: TestSession;
  let stripe: FakeGateway;
  let culqi: FakeGateway;
  let fx: CatalogFixture;
  const alertLog: { code: string; bookingId?: string }[] = [];
  const http = () => request(app.getHttpServer());
  const alerted = (bookingId: string, code: string) =>
    alertLog.filter((a) => a.bookingId === bookingId && a.code === code).length;

  beforeAll(async () => {
    app = await createTestApp((b) =>
      b
        .overrideProvider(DOCUMENT_STORAGE)
        .useValue(new MemoryDocumentStorage())
        .overrideProvider(StaffAlertsService)
        .useValue({
          alert: (code: string, _d: Body, o: { bookingId?: string } = {}) => {
            alertLog.push({ code, bookingId: o.bookingId });
            return Promise.resolve();
          },
        }),
    );
    prisma = app.get(PrismaService);
    const registry = app.get(GatewayRegistry);
    stripe = registry.get('STRIPE') as FakeGateway;
    culqi = registry.get('CULQI') as FakeGateway;
    admin = await loginAs(app, 'admin');
    operator = await loginAs(app, 'operator');
    fx = await createCatalog(app);
    await ensureBilling(app);
  });
  afterAll(async () => {
    await app.close();
  });
  afterEach(() => {
    stripe.failRefunds = false;
    stripe.loseRefundResponse = false;
    culqi.failRefunds = false;
    culqi.loseRefundResponse = false;
  });

  const payment = (id: string) =>
    prisma.payment.findUniqueOrThrow({ where: { id } });
  const booking = (id: string) =>
    prisma.booking.findUniqueOrThrow({ where: { id } });

  const stripeIntent = (b: DirectBooking, kind = 'FULL') =>
    http()
      .post(`/api/public/bookings/${b.reference}/payments/stripe-intent`)
      .set('X-Booking-Token', b.token)
      .send({ kind });

  const succeededEvent = (p: Body, eventId = evt()): GatewayEvent => ({
    kind: 'payment',
    eventId,
    type: 'payment_intent.succeeded',
    payment: {
      providerRef: p.providerRef,
      status: 'SUCCEEDED',
      amountCents: p.amountCents,
      currency: p.currency,
      metadata: { paymentId: p.id },
    },
  });

  // ------------------------------------------------- Doble gasto (pagos)
  describe('simultaneous payments', () => {
    it('credits a payment once when several events for it arrive at the same time', async () => {
      const b = await makeBooking(app, fx);
      const intent = (await stripeIntent(b).expect(201)).body as Body;
      const p = await payment(intent.paymentId);
      // Mismo cobro, ids de evento distintos (el caso que la idempotencia por evento no cubre).
      const results = await Promise.all(
        Array.from({ length: 6 }, () =>
          postWebhook(app, 'stripe', succeededEvent(p)),
        ),
      );
      expect(results.map((r) => r.status)).toEqual(Array(6).fill(200));
      expect(await booking(b.id)).toMatchObject({
        status: 'CONFIRMED',
        paidCents: b.total,
        refundedCents: 0,
      });
      expect(await prisma.refund.count({ where: { paymentId: p.id } })).toBe(0);
      expect(
        await prisma.auditLog.count({
          where: {
            entity: 'Payment',
            entityId: p.id,
            action: 'payment.succeeded',
          },
        }),
      ).toBe(1);
    });

    it('processes one delivery of the same event id when it is repeated at once', async () => {
      const b = await makeBooking(app, fx);
      const intent = (await stripeIntent(b).expect(201)).body as Body;
      const p = await payment(intent.paymentId);
      const event = succeededEvent(p);
      const results = await Promise.all(
        Array.from({ length: 6 }, () => postWebhook(app, 'stripe', event)),
      );
      expect(results.map((r) => r.status)).toEqual(Array(6).fill(200));
      expect((await booking(b.id)).paidCents).toBe(b.total);
      expect(
        await prisma.webhookEvent.count({
          where: { provider: 'STRIPE', eventId: event.eventId },
        }),
      ).toBe(1);
    });

    it('refunds the excess when two payments for the same booking succeed at the same time', async () => {
      const b = await makeBooking(app, fx);
      const [a, c] = await Promise.all([stripeIntent(b), stripeIntent(b)]);
      const p1 = await payment((a.body as Body).paymentId);
      const p2 = await payment((c.body as Body).paymentId);
      expect(p1.id).not.toBe(p2.id);
      await Promise.all([
        postWebhook(app, 'stripe', succeededEvent(p1)),
        postWebhook(app, 'stripe', succeededEvent(p2)),
      ]).then((rs) => rs.forEach((r) => expect(r.status).toBe(200)));
      const row = await booking(b.id);
      expect(row).toMatchObject({
        status: 'CONFIRMED',
        paidCents: b.total * 2,
        refundedCents: b.total,
      });
      expect(row.paidCents - row.refundedCents).toBe(b.total); // el cliente pagó el total una sola vez
      const refunds = await prisma.refund.findMany({
        where: { payment: { bookingId: b.id } },
      });
      expect(refunds).toHaveLength(1);
      expect(refunds[0]).toMatchObject({
        status: 'SUCCEEDED',
        amountCents: b.total,
        reason: 'overpayment',
      });
      expect(
        stripe.refunds.filter((r) => r.providerRef === refunds[0].providerRef),
      ).toHaveLength(1);
      expect(alerted(b.id, 'payment_overpaid')).toBe(1);
    });

    it('allows only one open payment per payment link under simultaneous requests', async () => {
      const b = await makeBooking(app, fx);
      const created = await http()
        .post(`/api/bookings/${b.id}/payment-links`)
        .set(admin.auth)
        .send({ kind: 'FULL' })
        .expect(201);
      const token = (created.body as Body).token as string;
      const res = await Promise.all(
        Array.from({ length: 4 }, () =>
          http().post(`/api/public/payment-links/${token}/stripe-intent`),
        ),
      );
      const statuses = res.map((r) => r.status).sort();
      expect(statuses).toEqual([201, 409, 409, 409]);
      expect(await prisma.payment.count({ where: { bookingId: b.id } })).toBe(
        1,
      );
    });
  });

  // ---------------------------------------------- Doble gasto (reembolsos)
  describe('simultaneous refunds', () => {
    it('refunds the same money only once', async () => {
      const b = await makeBooking(app, fx);
      const p = await recordPaid(app, b);
      const before = stripe.refunds.length;
      const res = await Promise.all(
        Array.from({ length: 4 }, (_, i) =>
          http()
            .post(`/api/payments/${p.id}/refunds`)
            .set(admin.auth)
            .set('Idempotency-Key', `k-${i}-${rand()}${rand()}`)
            .send({ amountCents: b.total, reason: 'doble clic' }),
        ),
      );
      expect(res.map((r) => r.status).sort()).toEqual([201, 409, 409, 409]);
      expect(stripe.refunds.length).toBe(before + 1);
      expect(await payment(p.id)).toMatchObject({
        status: 'REFUNDED',
        refundedCents: b.total,
      });
      expect((await booking(b.id)).refundedCents).toBe(b.total);
    });

    it('does not let simultaneous operator refunds jump over the operator limit', async () => {
      const b = await makeBooking(app, fx, { currency: 'PEN', adults: 4 }); // 144000
      const p = await recordPaid(app, b);
      const res = await Promise.all(
        Array.from({ length: 4 }, () =>
          http()
            .post(`/api/payments/${p.id}/refunds`)
            .set(operator.auth)
            .send({ amountCents: 12000, reason: 'x' }),
        ),
      );
      // Tope 20000: solo cabe uno de 12000 (el segundo sumaría 24000).
      expect(res.map((r) => r.status).sort()).toEqual([201, 403, 403, 403]);
      expect((await payment(p.id)).refundedCents).toBe(12000);
    });

    it('executes a pending refund once even if two sweeps and a manual refund overlap', async () => {
      const b = await makeBooking(app, fx);
      const p = await recordPaid(app, b);
      await prisma.refund.create({
        data: {
          paymentId: p.id,
          amountCents: 5000,
          reason: 'cancelación',
          status: 'PENDING',
        },
      });
      const before = stripe.refunds.length;
      await Promise.all([
        app.get(RefundSweeper).runOnce(),
        app.get(RefundSweeper).runOnce(),
        http()
          .post(`/api/payments/${p.id}/refunds`)
          .set(admin.auth)
          .send({ amountCents: b.total - 5000, reason: 'resto' }),
      ]);
      const total = stripe.refunds
        .slice(before)
        .reduce((n, r) => n + r.amountCents, 0);
      expect(total).toBeLessThanOrEqual(b.total);
      expect((await payment(p.id)).refundedCents).toBe(total);
      expect((await booking(b.id)).refundedCents).toBe(total);
    });
  });

  // ------------------------------------------------ Reembolso ambiguo (Culqi)
  describe('a Culqi refund whose response is lost', () => {
    const culqiPaid = async () => {
      const b = await makeBooking(app, fx, { currency: 'PEN' });
      const p = await recordPaid(app, b, { provider: 'CULQI' });
      culqi.payments.set(p.providerRef!, {
        providerRef: p.providerRef!,
        status: 'SUCCEEDED',
        amountCents: p.amountCents,
        currency: 'PEN',
        metadata: {},
        refundedCents: 0,
      });
      return { b, p };
    };

    it('does not refund twice: sees that the gateway already applied it', async () => {
      const { b, p } = await culqiPaid();
      await prisma.refund.create({
        data: {
          paymentId: p.id,
          amountCents: 3000,
          reason: 'cancelación',
          status: 'PENDING',
        },
      });
      culqi.loseRefundResponse = true;
      const before = culqi.refunds.length;
      await app.get(RefundSweeper).runOnce();
      culqi.loseRefundResponse = false;
      const row = await prisma.refund.findFirstOrThrow({
        where: { paymentId: p.id },
      });
      expect(row).toMatchObject({ status: 'SUCCEEDED' });
      expect(row.providerRef).toMatch(/^unconfirmed:/);
      expect(await payment(p.id)).toMatchObject({ refundedCents: 3000 });
      expect((await booking(b.id)).refundedCents).toBe(3000);
      await app.get(RefundSweeper).runOnce();
      expect(culqi.refunds.length).toBe(before); // no hubo una segunda llamada real
    });

    it('retries when the gateway did not apply it, and gives up for the staff when it cannot tell', async () => {
      const { p } = await culqiPaid();
      const pending = await prisma.refund.create({
        data: {
          paymentId: p.id,
          amountCents: 1000,
          reason: 'x',
          status: 'PENDING',
        },
      });
      culqi.failRefunds = true;
      culqi.refundFailureCode = 'unreachable';
      await app.get(RefundSweeper).runOnce();
      // El cargo muestra 0 devuelto: no se aplicó, se reintenta.
      expect(
        (await prisma.refund.findUniqueOrThrow({ where: { id: pending.id } }))
          .status,
      ).toBe('PENDING');
      culqi.failRefunds = false;
      await app.get(RefundSweeper).runOnce();
      expect(
        (await prisma.refund.findUniqueOrThrow({ where: { id: pending.id } }))
          .status,
      ).toBe('SUCCEEDED');

      // Sin poder consultar el cargo no se reintenta a ciegas.
      const b2 = await makeBooking(app, fx, { currency: 'PEN' });
      const p2 = await recordPaid(app, b2, { provider: 'CULQI' }); // el cargo no existe en la pasarela simulada
      const unknown = await prisma.refund.create({
        data: {
          paymentId: p2.id,
          amountCents: 1000,
          reason: 'x',
          status: 'PENDING',
        },
      });
      culqi.failRefunds = true;
      culqi.refundFailureCode = 'unreachable';
      await app.get(RefundSweeper).runOnce();
      expect(
        (await prisma.refund.findUniqueOrThrow({ where: { id: unknown.id } }))
          .status,
      ).toBe('FAILED');
      expect(alerted(b2.id, 'refund_failed')).toBe(1);
    });
  });

  // ------------------------------------------------ Webhooks fuera de orden
  describe('out-of-order webhooks', () => {
    it('asks the gateway to resend a refund that arrives before the payment is confirmed', async () => {
      const b = await makeBooking(app, fx);
      const intent = (await stripeIntent(b).expect(201)).body as Body;
      const p = await payment(intent.paymentId);
      const refundEvent: GatewayEvent = {
        kind: 'refund',
        eventId: evt(),
        type: 'refund.updated',
        refund: {
          providerRef: `re_${rand()}${rand()}`,
          paymentProviderRef: p.providerRef!,
          status: 'SUCCEEDED',
          amountCents: 2500,
        },
      };
      await postWebhook(app, 'stripe', refundEvent).expect(409);
      const stored = await prisma.webhookEvent.findFirstOrThrow({
        where: { provider: 'STRIPE', eventId: refundEvent.eventId },
      });
      expect(stored.processedAt).toBeNull();
      expect(stored.error).toContain('not settled');
      expect(await prisma.refund.count({ where: { paymentId: p.id } })).toBe(0);
      expect((await booking(b.id)).refundedCents).toBe(0);

      await postWebhook(app, 'stripe', succeededEvent(p)).expect(200);
      await postWebhook(app, 'stripe', refundEvent).expect(200); // el reenvío ahora sí se aplica
      expect(await payment(p.id)).toMatchObject({
        refundedCents: 2500,
        status: 'PARTIALLY_REFUNDED',
      });
      expect(await booking(b.id)).toMatchObject({
        paidCents: b.total,
        refundedCents: 2500,
      });
      await postWebhook(app, 'stripe', refundEvent).expect(200); // y no se aplica dos veces
      expect((await booking(b.id)).refundedCents).toBe(2500);
    });

    it('does the same for a dispute that arrives before the payment is confirmed', async () => {
      const b = await makeBooking(app, fx);
      const intent = (await stripeIntent(b).expect(201)).body as Body;
      const p = await payment(intent.paymentId);
      const disputeEvent = {
        kind: 'dispute',
        eventId: evt(),
        type: 'charge.dispute.created',
        dispute: {
          providerRef: `dp_${rand()}${rand()}`,
          paymentProviderRef: p.providerRef,
          status: 'OPEN',
          reason: 'fraudulent',
          amountCents: p.amountCents,
          currency: 'USD',
          evidenceDueAt: null,
        },
      } as unknown as GatewayEvent;
      await postWebhook(app, 'stripe', disputeEvent).expect(409);
      expect(await prisma.dispute.count({ where: { paymentId: p.id } })).toBe(
        0,
      );
      await postWebhook(app, 'stripe', succeededEvent(p)).expect(200);
      await postWebhook(app, 'stripe', disputeEvent).expect(200);
      expect(await payment(p.id)).toMatchObject({ status: 'DISPUTED' });
      expect(await prisma.dispute.count({ where: { paymentId: p.id } })).toBe(
        1,
      );
    });

    it('ignores a cancellation or a requires-action that arrives after the payment succeeded', async () => {
      const b = await makeBooking(app, fx);
      const p = await payment(
        ((await stripeIntent(b).expect(201)).body as Body).paymentId,
      );
      await postWebhook(app, 'stripe', succeededEvent(p)).expect(200);
      for (const status of [
        'CANCELLED',
        'REQUIRES_ACTION',
        'FAILED',
        'PENDING',
      ] as const) {
        await postWebhook(app, 'stripe', {
          kind: 'payment',
          eventId: evt(),
          type: 'payment_intent.x',
          payment: {
            providerRef: p.providerRef!,
            status,
            amountCents: p.amountCents,
            currency: 'USD',
            metadata: { paymentId: p.id },
          },
        }).expect(200);
      }
      expect(await payment(p.id)).toMatchObject({
        status: 'SUCCEEDED',
        failureCode: null,
      });
      expect((await booking(b.id)).status).toBe('CONFIRMED');
    });

    it('lets a late success rescue a payment that an earlier failure had marked failed', async () => {
      const b = await makeBooking(app, fx);
      const p = await payment(
        ((await stripeIntent(b).expect(201)).body as Body).paymentId,
      );
      await postWebhook(app, 'stripe', {
        kind: 'payment',
        eventId: evt(),
        type: 'payment_intent.payment_failed',
        payment: {
          providerRef: p.providerRef!,
          status: 'FAILED',
          amountCents: p.amountCents,
          currency: 'USD',
          failureCode: 'card_declined',
          metadata: { paymentId: p.id },
        },
      }).expect(200);
      await postWebhook(app, 'stripe', succeededEvent(p)).expect(200);
      expect(await payment(p.id)).toMatchObject({
        status: 'SUCCEEDED',
        failureCode: null,
      });
      expect((await booking(b.id)).paidCents).toBe(b.total);
    });
  });

  // -------------------------------------------------- Comprobantes y carreras
  describe('documents under concurrency', () => {
    it('documents the same money only once when manual and automatic issuing race', async () => {
      const b = await makeBooking(app, fx);
      const p = await recordPaid(app, b);
      const docs = app.get(DocumentsService);
      const [manual, auto] = await Promise.all([
        http().post(`/api/bookings/${b.id}/documents`).set(admin.auth).send({}),
        docs.autoIssueForPayment(p.id),
      ]);
      expect([202, 409]).toContain(manual.status);
      const rows = await prisma.document.findMany({
        where: { bookingId: b.id },
      });
      expect(rows.reduce((n, d) => n + d.totalCents, 0)).toBe(b.total);
      expect(rows.length).toBe(1);
      expect(typeof auto).toBe('boolean');
    });

    it('answers 409 to the simultaneous duplicate of a manual issue', async () => {
      const b = await makeBooking(app, fx);
      await recordPaid(app, b);
      const res = await Promise.all(
        Array.from({ length: 4 }, () =>
          http()
            .post(`/api/bookings/${b.id}/documents`)
            .set(admin.auth)
            .send({}),
        ),
      );
      expect(res.map((r) => r.status).sort()).toEqual([202, 409, 409, 409]);
      expect(await prisma.document.count({ where: { bookingId: b.id } })).toBe(
        1,
      );
    });

    it('does not let a payment-level issue duplicate a booking-level document', async () => {
      const b = await makeBooking(app, fx);
      const p = await recordPaid(app, b);
      await http()
        .post(`/api/bookings/${b.id}/documents`)
        .set(admin.auth)
        .send({})
        .expect(202);
      await http()
        .post(`/api/bookings/${b.id}/documents`)
        .set(admin.auth)
        .send({ paymentId: p.id })
        .expect(409);
      expect(await app.get(DocumentsService).autoIssueForPayment(p.id)).toBe(
        false,
      );
      expect(await prisma.document.count({ where: { bookingId: b.id } })).toBe(
        1,
      );
    });
  });

  // ------------------------------------------------------------ Autorización
  describe('authorization', () => {
    const fakeId = '00000000-0000-4000-8000-000000000000';
    const routes: [string, string][] = [
      ['get', '/api/payments'],
      ['get', `/api/payments/${fakeId}`],
      ['post', `/api/payments/${fakeId}/refunds`],
      ['get', '/api/refunds'],
      ['post', `/api/refunds/${fakeId}/complete`],
      ['get', '/api/disputes'],
      ['get', `/api/disputes/${fakeId}`],
      ['patch', `/api/disputes/${fakeId}`],
      ['get', `/api/disputes/${fakeId}/evidence`],
      ['get', '/api/documents'],
      ['get', `/api/documents/${fakeId}`],
      ['post', `/api/bookings/${fakeId}/documents`],
      ['post', `/api/documents/${fakeId}/retry`],
      ['post', `/api/documents/${fakeId}/void`],
      ['post', `/api/documents/${fakeId}/credit-note`],
      ['get', `/api/documents/${fakeId}/files/pdf`],
    ];

    it.each(routes)('%s %s requires a staff session', async (method, path) => {
      const r = (
        http() as unknown as Record<string, (p: string) => request.Test>
      )[method](path);
      await r.send({}).expect(401);
      await (http() as unknown as Record<string, (p: string) => request.Test>)
        [method](path)
        .set('Authorization', 'Bearer not-a-token')
        .send({})
        .expect(401);
    });

    it('does not let a booking token or a payment link token reach the staff routes', async () => {
      const b = await makeBooking(app, fx);
      await http()
        .get('/api/payments')
        .set('X-Booking-Token', b.token)
        .expect(401);
      await http()
        .post(`/api/bookings/${b.id}/documents`)
        .set('X-Booking-Token', b.token)
        .send({})
        .expect(401);
    });

    it('keeps void, credit notes and large refunds away from operators', async () => {
      const b = await makeBooking(app, fx, { currency: 'PEN', adults: 4 });
      const p = await recordPaid(app, b);
      await http()
        .post(`/api/payments/${p.id}/refunds`)
        .set(operator.auth)
        .send({ amountCents: 20001, reason: 'x' })
        .expect(403);
      await http()
        .post(`/api/documents/${fakeId}/void`)
        .set(operator.auth)
        .send({ reason: 'x' })
        .expect(403);
      await http()
        .post(`/api/documents/${fakeId}/credit-note`)
        .set(operator.auth)
        .send({ reason: 'x', amountCents: 1 })
        .expect(403);
      expect((await payment(p.id)).refundedCents).toBe(0);
    });

    it('public payment endpoints reject another booking’s token and never expose staff data', async () => {
      const a = await makeBooking(app, fx);
      const other = await makeBooking(app, fx);
      await http()
        .post(`/api/public/bookings/${a.reference}/payments/stripe-intent`)
        .set('X-Booking-Token', other.token)
        .send({ kind: 'FULL' })
        .expect(401);
      await http()
        .post(`/api/public/bookings/${a.reference}/payments/culqi-charge`)
        .set('X-Booking-Token', other.token)
        .send({ kind: 'FULL', token: 'tok_ok', email: 'a@example.com' })
        .expect(401);
      expect(await prisma.payment.count({ where: { bookingId: a.id } })).toBe(
        0,
      );
    });

    it('rejects extra fields and a card number on the payment endpoints', async () => {
      const b = await makeBooking(app, fx);
      await http()
        .post(`/api/public/bookings/${b.reference}/payments/culqi-charge`)
        .set('X-Booking-Token', b.token)
        .send({
          kind: 'FULL',
          token: 'tok_ok',
          email: 'a@example.com',
          cardNumber: '4111111111111111',
        })
        .expect(422);
      await http()
        .post(`/api/public/bookings/${b.reference}/payments/stripe-intent`)
        .set('X-Booking-Token', b.token)
        .send({ kind: 'FULL', amountCents: 1 })
        .expect(422);
      expect(await prisma.payment.count({ where: { bookingId: b.id } })).toBe(
        0,
      );
    });
  });

  // ----------------------------------------------------------------- Secretos
  describe('secrets', () => {
    it('never stores the Stripe client secret in a webhook event or an idempotency record', async () => {
      const b = await makeBooking(app, fx);
      const key = `k-${rand()}${rand()}`;
      const res = await http()
        .post(`/api/public/bookings/${b.reference}/payments/stripe-intent`)
        .set('X-Booking-Token', b.token)
        .set('Idempotency-Key', key)
        .send({ kind: 'FULL' })
        .expect(201);
      const secret = (res.body as Body).clientSecret as string;
      expect(secret).toContain('_secret_');
      const rec = await prisma.idempotencyRecord.findFirstOrThrow({
        where: { key },
      });
      expect(JSON.stringify(rec)).not.toContain(secret);

      const p = await payment((res.body as Body).paymentId);
      const event = succeededEvent(p);
      (event as { payment: Body }).payment.clientSecret = secret;
      await postWebhook(app, 'stripe', event).expect(200);
      const stored = await prisma.webhookEvent.findFirstOrThrow({
        where: { eventId: event.eventId },
      });
      expect(JSON.stringify(stored)).not.toContain(secret);
      expect(JSON.stringify(stored)).not.toContain('clientSecret');
      const audits = await prisma.auditLog.findMany({
        where: { entity: 'Payment', entityId: p.id },
      });
      expect(JSON.stringify(audits)).not.toContain(secret);
    });

    it('does not keep the Culqi token anywhere', async () => {
      const b = await makeBooking(app, fx, { currency: 'PEN' });
      const token = 'tok_ok';
      const key = `k-${rand()}${rand()}`;
      const res = await http()
        .post(`/api/public/bookings/${b.reference}/payments/culqi-charge`)
        .set('X-Booking-Token', b.token)
        .set('Idempotency-Key', key)
        .send({ kind: 'FULL', token, email: 'private-person@example.com' })
        .expect(201);
      const rec = await prisma.idempotencyRecord.findFirstOrThrow({
        where: { key },
      });
      expect(JSON.stringify(rec)).not.toContain(token);
      expect(JSON.stringify(rec)).not.toContain('private-person@example.com');
      const p = await payment((res.body as Body).paymentId);
      expect(JSON.stringify(p)).not.toContain(token);
      const audits = await prisma.auditLog.findMany({
        where: { entity: 'Payment', entityId: p.id },
      });
      expect(JSON.stringify(audits)).not.toContain(token);
      expect(JSON.stringify(audits)).not.toContain(
        'private-person@example.com',
      );
    });
  });
});
