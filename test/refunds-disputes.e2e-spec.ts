import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { GatewayRegistry } from '../src/modules/payments/gateway.registry';
import { FakeGateway } from '../src/modules/payments/providers/fake.gateway';
import type { GatewayEvent } from '../src/modules/payments/providers/payment-gateway';
import { RefundSweeper } from '../src/modules/payments/refund-sweeper.service';
import { StaffAlertsService } from '../src/modules/payments/staff-alerts.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { CatalogFixture, createCatalog, rand } from './fixtures';
import { createTestApp, loginAs, TestSession } from './helpers';
import {
  DirectBooking,
  evt,
  makeBooking,
  postWebhook,
  readZip,
  recordPaid,
} from './payment-helpers';

type Body = Record<string, any>;

describe('Reembolsos y disputas (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let admin: TestSession;
  let operator: TestSession;
  let stripe: FakeGateway;
  let fx: CatalogFixture;
  const alertLog: { code: string; bookingId?: string }[] = [];
  const http = () => request(app.getHttpServer());
  const alertsFor = (bookingId: string, code: string) =>
    alertLog.filter((a) => a.bookingId === bookingId && a.code === code).length;

  beforeAll(async () => {
    app = await createTestApp((b) =>
      b.overrideProvider(StaffAlertsService).useValue({
        alert: (code: string, _d: Body, o: { bookingId?: string } = {}) => {
          alertLog.push({ code, bookingId: o.bookingId });
          return Promise.resolve();
        },
      }),
    );
    prisma = app.get(PrismaService);
    stripe = app.get(GatewayRegistry).get('STRIPE') as FakeGateway;
    admin = await loginAs(app, 'admin');
    operator = await loginAs(app, 'operator');
    fx = await createCatalog(app);
  });
  afterAll(async () => {
    await app.close();
  });
  afterEach(() => {
    stripe.failRefunds = false;
    stripe.refundFailureCode = 'refund_failed';
  });

  const refund = (
    session: TestSession,
    paymentId: string,
    body: Body,
    key?: string,
  ) => {
    const r = http()
      .post(`/api/payments/${paymentId}/refunds`)
      .set(session.auth);
    if (key) r.set('Idempotency-Key', key);
    return r.send(body);
  };
  const payment = (id: string) =>
    prisma.payment.findUniqueOrThrow({ where: { id } });
  const booking = (id: string) =>
    prisma.booking.findUniqueOrThrow({ where: { id } });

  // ------------------------------------------------------------ Reembolsos
  describe('POST /payments/:id/refunds', () => {
    it('refunds through the original gateway and updates payment and booking', async () => {
      const b = await makeBooking(app, fx);
      const p = await recordPaid(app, b);
      const res = await refund(admin, p.id, {
        amountCents: 5000,
        reason: 'cortesía',
      }).expect(201);
      expect(res.body).toMatchObject({
        paymentId: p.id,
        bookingId: b.id,
        bookingReference: b.reference,
        currency: 'USD',
        amountCents: 5000,
        status: 'SUCCEEDED',
        requestedBy: admin.user.email,
      });
      expect(
        stripe.refunds.some(
          (r) =>
            r.paymentProviderRef === p.providerRef && r.amountCents === 5000,
        ),
      ).toBe(true);
      expect(await payment(p.id)).toMatchObject({
        status: 'PARTIALLY_REFUNDED',
        refundedCents: 5000,
      });
      expect((await booking(b.id)).refundedCents).toBe(5000);
      const audit = await prisma.auditLog.findMany({
        where: { entity: 'Refund', entityId: (res.body as Body).id },
      });
      expect(audit.map((a) => a.action)).toEqual(
        expect.arrayContaining(['refund.create', 'refund.execute']),
      );

      await refund(admin, p.id, { amountCents: 15001, reason: 'x' }).expect(
        409,
      );
      await refund(admin, p.id, { amountCents: 15000, reason: 'resto' }).expect(
        201,
      );
      expect(await payment(p.id)).toMatchObject({
        status: 'REFUNDED',
        refundedCents: 20000,
      });
      await refund(admin, p.id, { amountCents: 1, reason: 'x' }).expect(409);
    });

    it('rejects zero, negative, fractional and missing amounts, and unknown payments', async () => {
      const b = await makeBooking(app, fx);
      const p = await recordPaid(app, b);
      for (const amountCents of [0, -5, 10.5, 'cien', null]) {
        await refund(admin, p.id, { amountCents, reason: 'x' }).expect(422);
      }
      await refund(admin, p.id, { amountCents: 100 }).expect(422);
      await refund(admin, p.id, { amountCents: 100, reason: '' }).expect(422);
      await refund(admin, '00000000-0000-4000-8000-000000000000', {
        amountCents: 1,
        reason: 'x',
      }).expect(404);
      await http()
        .post(`/api/payments/${p.id}/refunds`)
        .send({ amountCents: 1, reason: 'x' })
        .expect(401);
      expect((await payment(p.id)).refundedCents).toBe(0);
    });

    it('repeating the Idempotency-Key does not refund twice', async () => {
      const b = await makeBooking(app, fx);
      const p = await recordPaid(app, b);
      const key = `k-${rand()}${rand()}`;
      const before = stripe.refunds.length;
      const a = await refund(
        admin,
        p.id,
        { amountCents: 3000, reason: 'x' },
        key,
      ).expect(201);
      const again = await refund(
        admin,
        p.id,
        { amountCents: 3000, reason: 'x' },
        key,
      ).expect(201);
      expect((again.body as Body).id).toBe((a.body as Body).id);
      expect(stripe.refunds.length).toBe(before + 1);
      expect((await payment(p.id)).refundedCents).toBe(3000);
      await refund(admin, p.id, { amountCents: 4000, reason: 'x' }, key).expect(
        422,
      ); // otro cuerpo
    });

    it('limits operators by what was already refunded on the booking and lets refund-any through', async () => {
      const b = await makeBooking(app, fx, { currency: 'PEN', adults: 4 }); // 144000
      const p = await recordPaid(app, b);
      await refund(operator, p.id, { amountCents: 20001, reason: 'x' }).expect(
        403,
      );
      await refund(operator, p.id, { amountCents: 12000, reason: 'x' }).expect(
        201,
      );
      // 12000 ya devueltos + 9000 > 20000: no se puede partir el reembolso para evitar el tope.
      await refund(operator, p.id, { amountCents: 9000, reason: 'x' }).expect(
        403,
      );
      await refund(operator, p.id, { amountCents: 8000, reason: 'x' }).expect(
        201,
      );
      const big = await refund(admin, p.id, {
        amountCents: 100000,
        reason: 'x',
      }).expect(201);
      const row = await prisma.refund.findUniqueOrThrow({
        where: { id: (big.body as Body).id },
      });
      expect(row.approvedByUserId).toBe(admin.user.id);
      expect((await payment(p.id)).refundedCents).toBe(120000);
    });

    it('does not refund a payment that is not succeeded or is disputed', async () => {
      const b = await makeBooking(app, fx);
      const failed = await prisma.payment.create({
        data: {
          bookingId: b.id,
          provider: 'STRIPE',
          method: 'CARD',
          kind: 'FULL',
          status: 'FAILED',
          currency: 'USD',
          amountCents: 100,
          providerRef: `pi_f_${rand()}`,
        },
      });
      await refund(admin, failed.id, { amountCents: 100, reason: 'x' }).expect(
        409,
      );
    });

    it('keeps the refund pending when the gateway is unreachable and fails it when it refuses', async () => {
      const b = await makeBooking(app, fx);
      const p = await recordPaid(app, b);
      stripe.failRefunds = true;
      stripe.refundFailureCode = 'unreachable';
      const pending = await refund(admin, p.id, {
        amountCents: 1000,
        reason: 'x',
      }).expect(201);
      expect(pending.body).toMatchObject({ status: 'PENDING' });
      expect((await payment(p.id)).refundedCents).toBe(0);

      stripe.failRefunds = false;
      await app.get(RefundSweeper).runOnce();
      expect(
        await prisma.refund.findUniqueOrThrow({
          where: { id: (pending.body as Body).id },
        }),
      ).toMatchObject({ status: 'SUCCEEDED' });
      expect((await payment(p.id)).refundedCents).toBe(1000);

      stripe.failRefunds = true; // rechazo definitivo
      stripe.refundFailureCode = 'refund_failed';
      const refused = await refund(admin, p.id, {
        amountCents: 500,
        reason: 'x',
      }).expect(201);
      expect(refused.body).toMatchObject({ status: 'FAILED' });
      expect(alertsFor(b.id, 'refund_failed')).toBe(1);
      expect((await payment(p.id)).refundedCents).toBe(1000);
    });
  });

  describe('manual payments', () => {
    it('records a refund of a manual payment right away', async () => {
      const b = await makeBooking(app, fx);
      const p = await recordPaid(app, b, { provider: 'MANUAL' });
      const res = await refund(admin, p.id, {
        amountCents: 4000,
        reason: 'devuelto en caja',
      }).expect(201);
      expect(res.body).toMatchObject({ status: 'SUCCEEDED' });
      expect(await payment(p.id)).toMatchObject({
        status: 'PARTIALLY_REFUNDED',
        refundedCents: 4000,
      });
      expect(
        stripe.refunds.every((r) => r.paymentProviderRef !== p.providerRef),
      ).toBe(true);
    });

    it('lets staff confirm the pending refund that a cancellation left', async () => {
      const b = await makeBooking(app, fx);
      const p = await recordPaid(app, b, { provider: 'MANUAL' });
      const pending = await prisma.refund.create({
        data: {
          paymentId: p.id,
          amountCents: 20000,
          reason: 'cancelación',
          status: 'PENDING',
        },
      });
      await app.get(RefundSweeper).runOnce();
      expect(
        (await prisma.refund.findUniqueOrThrow({ where: { id: pending.id } }))
          .status,
      ).toBe('PENDING'); // no es de pasarela

      const done = await http()
        .post(`/api/refunds/${pending.id}/complete`)
        .set(operator.auth)
        .expect(200);
      expect(done.body).toMatchObject({
        status: 'SUCCEEDED',
        amountCents: 20000,
      });
      expect(await payment(p.id)).toMatchObject({
        status: 'REFUNDED',
        refundedCents: 20000,
      });
      expect((await booking(b.id)).refundedCents).toBe(20000);
      await http()
        .post(`/api/refunds/${pending.id}/complete`)
        .set(operator.auth)
        .expect(409);
      await http()
        .post(`/api/refunds/00000000-0000-4000-8000-000000000000/complete`)
        .set(operator.auth)
        .expect(404);
    });

    it('does not let staff confirm a gateway refund by hand', async () => {
      const b = await makeBooking(app, fx);
      const p = await recordPaid(app, b);
      const pending = await prisma.refund.create({
        data: {
          paymentId: p.id,
          amountCents: 100,
          reason: 'x',
          status: 'PENDING',
          providerRef: 're_x',
        },
      });
      await http()
        .post(`/api/refunds/${pending.id}/complete`)
        .set(admin.auth)
        .expect(409);
    });
  });

  describe('pending refunds left by cancellations', () => {
    it('are executed by the sweeper against the original gateway', async () => {
      const b = await makeBooking(app, fx);
      const older = await recordPaid(app, b, {
        amountCents: 6000,
        kind: 'DEPOSIT',
      });
      const newer = await recordPaid(app, b, {
        amountCents: 14000,
        kind: 'BALANCE',
      });
      const r1 = await prisma.refund.create({
        data: {
          paymentId: newer.id,
          amountCents: 14000,
          reason: 'cancelación',
          status: 'PENDING',
        },
      });
      const r2 = await prisma.refund.create({
        data: {
          paymentId: older.id,
          amountCents: 1000,
          reason: 'cancelación',
          status: 'PENDING',
        },
      });
      await app.get(RefundSweeper).runOnce();
      await app.get(RefundSweeper).runOnce(); // idempotente
      expect(
        await prisma.refund.findUniqueOrThrow({ where: { id: r1.id } }),
      ).toMatchObject({ status: 'SUCCEEDED' });
      expect(
        await prisma.refund.findUniqueOrThrow({ where: { id: r2.id } }),
      ).toMatchObject({ status: 'SUCCEEDED' });
      expect(await payment(newer.id)).toMatchObject({
        status: 'REFUNDED',
        refundedCents: 14000,
      });
      expect(await payment(older.id)).toMatchObject({
        status: 'PARTIALLY_REFUNDED',
        refundedCents: 1000,
      });
      expect((await booking(b.id)).refundedCents).toBe(15000);
      expect(
        stripe.refunds.filter(
          (r) => r.paymentProviderRef === newer.providerRef,
        ),
      ).toHaveLength(1);
    });

    it('two sweeps at once refund only once', async () => {
      const b = await makeBooking(app, fx);
      const p = await recordPaid(app, b);
      await prisma.refund.create({
        data: {
          paymentId: p.id,
          amountCents: 2000,
          reason: 'x',
          status: 'PENDING',
        },
      });
      await Promise.all([
        app.get(RefundSweeper).runOnce(),
        app.get(RefundSweeper).runOnce(),
      ]);
      expect(
        stripe.refunds.filter((r) => r.paymentProviderRef === p.providerRef),
      ).toHaveLength(1);
      expect((await payment(p.id)).refundedCents).toBe(2000);
    });
  });

  // ---------------------------------------------------- Webhooks de reembolso
  describe('refund webhooks', () => {
    const refundEvent = (
      p: Body,
      status: 'SUCCEEDED' | 'FAILED' | 'PENDING',
      providerRef: string,
      amountCents: number,
      eventId = evt(),
    ) =>
      ({
        kind: 'refund',
        eventId,
        type: 'refund.updated',
        refund: {
          providerRef,
          paymentProviderRef: p.providerRef,
          status,
          amountCents,
        },
      }) as GatewayEvent;

    it('records a refund made from the gateway dashboard and alerts the staff', async () => {
      const b = await makeBooking(app, fx);
      const p = await recordPaid(app, b);
      const event = refundEvent(p, 'SUCCEEDED', `re_ext_${rand()}`, 7000);
      await postWebhook(app, 'stripe', event).expect(200);
      await postWebhook(app, 'stripe', event).expect(200); // duplicado
      const rows = await prisma.refund.findMany({ where: { paymentId: p.id } });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        reason: 'external',
        status: 'SUCCEEDED',
        amountCents: 7000,
      });
      expect(await payment(p.id)).toMatchObject({
        refundedCents: 7000,
        status: 'PARTIALLY_REFUNDED',
      });
      expect((await booking(b.id)).refundedCents).toBe(7000);
      expect(alertsFor(b.id, 'refund_external')).toBe(1);
    });

    it('closes a refund that was pending at the gateway and ignores stale events', async () => {
      const pendingRef = `re_p_${rand()}${rand()}`;
      const b = await makeBooking(app, fx);
      const p = await recordPaid(app, b);
      const pending = await prisma.refund.create({
        data: {
          paymentId: p.id,
          amountCents: 3000,
          reason: 'x',
          status: 'PENDING',
          providerRef: pendingRef,
        },
      });
      await postWebhook(
        app,
        'stripe',
        refundEvent(p, 'PENDING', pendingRef, 3000),
      ).expect(200);
      expect(
        (await prisma.refund.findUniqueOrThrow({ where: { id: pending.id } }))
          .status,
      ).toBe('PENDING');
      await postWebhook(
        app,
        'stripe',
        refundEvent(p, 'SUCCEEDED', pendingRef, 3000),
      ).expect(200);
      expect((await payment(p.id)).refundedCents).toBe(3000);
      // Un "pending" atrasado no desmonta lo cerrado, y otro "succeeded" no suma dos veces.
      await postWebhook(
        app,
        'stripe',
        refundEvent(p, 'PENDING', pendingRef, 3000),
      ).expect(200);
      await postWebhook(
        app,
        'stripe',
        refundEvent(p, 'SUCCEEDED', pendingRef, 3000),
      ).expect(200);
      expect((await payment(p.id)).refundedCents).toBe(3000);
      expect(
        (await prisma.refund.findUniqueOrThrow({ where: { id: pending.id } }))
          .status,
      ).toBe('SUCCEEDED');
    });

    it('reverses a refund that fails after it was counted', async () => {
      const b = await makeBooking(app, fx);
      const p = await recordPaid(app, b);
      const res = await refund(admin, p.id, {
        amountCents: 5000,
        reason: 'x',
      }).expect(201);
      const row = await prisma.refund.findUniqueOrThrow({
        where: { id: (res.body as Body).id },
      });
      await postWebhook(
        app,
        'stripe',
        refundEvent(p, 'FAILED', row.providerRef!, 5000),
      ).expect(200);
      expect(await payment(p.id)).toMatchObject({
        refundedCents: 0,
        status: 'SUCCEEDED',
      });
      expect((await booking(b.id)).refundedCents).toBe(0);
      expect(
        (await prisma.refund.findUniqueOrThrow({ where: { id: row.id } }))
          .status,
      ).toBe('FAILED');
      expect(alertsFor(b.id, 'refund_reversed')).toBe(1);
    });

    it('rejects a bad signature', async () => {
      const b = await makeBooking(app, fx);
      const p = await recordPaid(app, b);
      await postWebhook(
        app,
        'stripe',
        refundEvent(p, 'SUCCEEDED', 're_bad', 100),
        true,
      ).expect(400);
      expect((await payment(p.id)).refundedCents).toBe(0);
    });
  });

  // ---------------------------------------------------------------- Disputas
  describe('disputes', () => {
    const disputeEvent = (
      p: Body,
      status: string,
      over: Body = {},
      eventId = evt(),
    ) =>
      ({
        kind: 'dispute',
        eventId,
        type: 'charge.dispute.created',
        dispute: {
          providerRef: over.providerRef ?? 'dp_x',
          paymentProviderRef: p.providerRef,
          status,
          reason: 'fraudulent',
          amountCents: p.amountCents,
          currency: p.currency,
          evidenceDueAt: '2026-12-01T00:00:00.000Z',
          ...over,
        },
      }) as GatewayEvent;

    it('opens a dispute from the webhook, marks the payment and alerts the staff', async () => {
      const b = await makeBooking(app, fx);
      const p = await recordPaid(app, b);
      const ref = `dp_${rand()}${rand()}`;
      const event = disputeEvent(p, 'OPEN', { providerRef: ref });
      await postWebhook(app, 'stripe', event).expect(200);
      await postWebhook(app, 'stripe', event).expect(200); // duplicado

      const rows = await prisma.dispute.findMany({
        where: { paymentId: p.id },
      });
      expect(rows).toHaveLength(1);
      expect(await payment(p.id)).toMatchObject({ status: 'DISPUTED' });
      expect(alertsFor(b.id, 'dispute_opened')).toBe(1);

      const got = await http()
        .get(`/api/disputes/${rows[0].id}`)
        .set(operator.auth)
        .expect(200);
      expect(got.body).toMatchObject({
        paymentId: p.id,
        bookingId: b.id,
        bookingReference: b.reference,
        provider: 'STRIPE',
        providerRef: ref,
        status: 'OPEN',
        reason: 'fraudulent',
        currency: 'USD',
        amountCents: 20000,
        evidenceDueAt: '2026-12-01T00:00:00.000Z',
      });
      const list = await http()
        .get('/api/disputes')
        .query({ status: 'OPEN' })
        .set(operator.auth)
        .expect(200);
      expect(
        (list.body as { data: Body[] }).data.some((d) => d.id === rows[0].id),
      ).toBe(true);
      const lost = await http()
        .get('/api/disputes')
        .query({ status: 'LOST' })
        .set(operator.auth)
        .expect(200);
      expect(
        (lost.body as { data: Body[] }).data.some((d) => d.id === rows[0].id),
      ).toBe(false);

      await refund(admin, p.id, { amountCents: 100, reason: 'x' }).expect(409); // pago en disputa
    });

    it('follows the dispute outcome and does not reopen it with a stale event', async () => {
      const b = await makeBooking(app, fx);
      const p = await recordPaid(app, b);
      const ref = `dp_${rand()}${rand()}`;
      await postWebhook(
        app,
        'stripe',
        disputeEvent(p, 'OPEN', { providerRef: ref }),
      ).expect(200);
      await postWebhook(
        app,
        'stripe',
        disputeEvent(p, 'WON', { providerRef: ref }),
      ).expect(200);
      expect(await payment(p.id)).toMatchObject({ status: 'SUCCEEDED' });
      await postWebhook(
        app,
        'stripe',
        disputeEvent(p, 'OPEN', { providerRef: ref }),
      ).expect(200);
      const row = await prisma.dispute.findFirstOrThrow({
        where: { providerRef: ref },
      });
      expect(row.status).toBe('WON');
      expect((await payment(p.id)).status).toBe('SUCCEEDED');
      expect(alertsFor(b.id, 'dispute_won')).toBe(1);

      const b2 = await makeBooking(app, fx);
      const p2 = await recordPaid(app, b2);
      const ref2 = `dp_${rand()}${rand()}`;
      await postWebhook(
        app,
        'stripe',
        disputeEvent(p2, 'OPEN', { providerRef: ref2 }),
      ).expect(200);
      await postWebhook(
        app,
        'stripe',
        disputeEvent(p2, 'LOST', { providerRef: ref2 }),
      ).expect(200);
      expect((await payment(p2.id)).status).toBe('DISPUTED'); // el dinero se perdió
      expect(alertsFor(b2.id, 'dispute_lost')).toBe(1);
    });

    it('lets staff edit notes and status, and refuses to reopen a closed dispute', async () => {
      const b = await makeBooking(app, fx);
      const p = await recordPaid(app, b);
      const ref = `dp_${rand()}${rand()}`;
      await postWebhook(
        app,
        'stripe',
        disputeEvent(p, 'OPEN', { providerRef: ref }),
      ).expect(200);
      const row = await prisma.dispute.findFirstOrThrow({
        where: { providerRef: ref },
      });

      const noted = await http()
        .patch(`/api/disputes/${row.id}`)
        .set(operator.auth)
        .send({ notes: 'Evidencia enviada' })
        .expect(200);
      expect(noted.body).toMatchObject({
        notes: 'Evidencia enviada',
        status: 'OPEN',
      });
      const closed = await http()
        .patch(`/api/disputes/${row.id}`)
        .set(operator.auth)
        .send({ status: 'CLOSED' })
        .expect(200);
      expect(closed.body).toMatchObject({ status: 'CLOSED' });
      expect((await payment(p.id)).status).toBe('SUCCEEDED');
      await http()
        .patch(`/api/disputes/${row.id}`)
        .set(operator.auth)
        .send({ status: 'OPEN' })
        .expect(409);
      await http()
        .patch(`/api/disputes/${row.id}`)
        .set(operator.auth)
        .send({ status: 'BOGUS' })
        .expect(422);
      await http()
        .patch(`/api/disputes/00000000-0000-4000-8000-000000000000`)
        .set(operator.auth)
        .send({ notes: 'x' })
        .expect(404);
      await http()
        .get(`/api/disputes/00000000-0000-4000-8000-000000000000`)
        .set(operator.auth)
        .expect(404);
      const audit = await prisma.auditLog.findMany({
        where: { entity: 'Dispute', entityId: row.id },
      });
      expect(JSON.stringify(audit)).not.toContain('Evidencia enviada'); // notas fuera de la auditoría
    });

    it('opens a dispute from a Culqi charge flagged as disputed', async () => {
      const b = await makeBooking(app, fx, { currency: 'PEN' });
      const p = await recordPaid(app, b, { provider: 'CULQI' });
      await postWebhook(app, 'culqi', {
        kind: 'payment',
        eventId: evt(),
        type: 'charge.update.succeeded',
        payment: {
          providerRef: p.providerRef!,
          status: 'SUCCEEDED',
          amountCents: p.amountCents,
          currency: 'PEN',
          metadata: { paymentId: p.id },
          disputed: true,
        },
      }).expect(200);
      const row = await prisma.dispute.findFirstOrThrow({
        where: { paymentId: p.id },
      });
      expect(row).toMatchObject({
        provider: 'CULQI',
        providerRef: p.providerRef,
        status: 'OPEN',
        currency: 'PEN',
      });
    });
  });

  // ---------------------------------------------------------------- Evidencia
  describe('GET /disputes/:id/evidence', () => {
    it('returns a ZIP with the confirmation, accepted policies, waiver, manifest and documents', async () => {
      const b = await makeBooking(app, fx);
      const p = await recordPaid(app, b);
      const row = await prisma.booking.findUniqueOrThrow({
        where: { id: b.id },
        include: { departure: true },
      });
      const passenger = await prisma.passenger.create({
        data: {
          bookingId: b.id,
          firstName: 'Ana',
          lastName: 'Pérez',
          idDocType: 'DNI',
          idDocNumber: '12345678',
        },
      });
      await prisma.waiver.create({
        data: {
          token: `w-${rand()}${rand()}`,
          bookingId: b.id,
          passengerId: passenger.id,
          tourRefId: row.departure.tourRefId,
          version: 1,
          status: 'SIGNED',
          signerName: 'Ana Pérez',
          signedAt: new Date(),
          ip: '203.0.113.7',
        },
      });
      const legal = await prisma.legalDocument.create({
        data: {
          kind: 'TERMS',
          locale: `ev-${rand()}`,
          version: 1,
          cmsSlug: 'terms',
          title: 'Términos y condiciones',
          textSnapshot: 'Texto exacto aceptado por el cliente.',
          contentHash: 'abc123',
          publishedAt: new Date(),
        },
      });
      await prisma.acceptance.create({
        data: {
          legalDocumentId: legal.id,
          bookingId: b.id,
          ip: '203.0.113.7',
          userAgent: 'jest',
        },
      });
      await prisma.notification.create({
        data: {
          bookingId: b.id,
          channel: 'EMAIL',
          template: 'booking_confirmed',
          toAddress: 'ana@example.com',
          status: 'SENT',
          sentAt: new Date(),
        },
      });
      const ref = `dp_${rand()}${rand()}`;
      await postWebhook(app, 'stripe', {
        kind: 'dispute',
        eventId: evt(),
        type: 'charge.dispute.created',
        dispute: {
          providerRef: ref,
          paymentProviderRef: p.providerRef!,
          status: 'OPEN',
          reason: 'product_not_received',
          amountCents: p.amountCents,
          currency: 'USD',
          evidenceDueAt: null,
        },
      }).expect(200);
      const dispute = await prisma.dispute.findFirstOrThrow({
        where: { providerRef: ref },
      });

      const res = await http()
        .get(`/api/disputes/${dispute.id}/evidence`)
        .set(operator.auth)
        .buffer(true)
        .parse((r, cb) => {
          const chunks: Buffer[] = [];
          r.on('data', (c: Buffer) => chunks.push(c));
          r.on('end', () => cb(null, Buffer.concat(chunks)));
        })
        .expect(200);
      expect(res.headers['content-type']).toContain('application/zip');
      expect(res.headers['content-disposition']).toMatch(
        /attachment; filename="disputa-.*\.zip"/,
      );

      const files = readZip(res.body as Buffer);
      const names = [...files.keys()];
      expect(names).toEqual(
        expect.arrayContaining([
          '01-confirmacion.json',
          '02-pagos.json',
          '03-politicas-aceptadas.json',
          '04-descargos.json',
          '05-manifiesto.json',
          '06-comprobantes.json',
          '07-auditoria.json',
          'LEEME.txt',
        ]),
      );
      const policy = names.find((n) => n.startsWith('politicas/terms-'))!;
      expect(files.get(policy)!.toString()).toContain(
        'Texto exacto aceptado por el cliente.',
      );
      expect(files.get(policy)!.toString()).toContain('203.0.113.7');
      const conf = JSON.parse(
        files.get('01-confirmacion.json')!.toString(),
      ) as Body;
      expect(conf).toMatchObject({
        reference: b.reference,
        totalCents: 20000,
        customer: { email: expect.any(String) },
      });
      expect(conf.emailsSent).toHaveLength(1);
      const pagos = JSON.parse(files.get('02-pagos.json')!.toString()) as Body;
      expect(pagos.dispute).toMatchObject({
        providerRef: ref,
        reason: 'product_not_received',
      });
      const waivers = JSON.parse(
        files.get('04-descargos.json')!.toString(),
      ) as Body;
      expect(waivers.waivers[0]).toMatchObject({
        status: 'SIGNED',
        signerName: 'Ana Pérez',
        ip: '203.0.113.7',
      });
      const manifest = JSON.parse(
        files.get('05-manifiesto.json')!.toString(),
      ) as Body;
      expect(manifest.passengers[0]).toMatchObject({
        name: 'Ana Pérez',
        waiverStatus: 'SIGNED',
      });

      await http()
        .get(`/api/disputes/00000000-0000-4000-8000-000000000000/evidence`)
        .set(operator.auth)
        .expect(404);
      await http().get(`/api/disputes/${dispute.id}/evidence`).expect(401);
    });
  });

  // ------------------------------------------------------------------ Listas
  describe('lists', () => {
    it('lists and filters payments and refunds with bookingReference and currency', async () => {
      const b: DirectBooking = await makeBooking(app, fx, { currency: 'PEN' });
      const p = await recordPaid(app, b, { provider: 'CULQI' });
      await refund(admin, p.id, { amountCents: 1000, reason: 'x' }).expect(201);

      const list = await http()
        .get('/api/payments')
        .query({
          provider: 'CULQI',
          status: 'PARTIALLY_REFUNDED',
          pageSize: 100,
        })
        .set(operator.auth)
        .expect(200);
      const found = (list.body as { data: Body[] }).data.find(
        (x) => x.id === p.id,
      )!;
      expect(found).toMatchObject({
        bookingReference: b.reference,
        currency: 'PEN',
        provider: 'CULQI',
        refundedCents: 1000,
      });
      const none = await http()
        .get('/api/payments')
        .query({ from: '2999-01-01T00:00:00Z' })
        .set(operator.auth)
        .expect(200);
      expect((none.body as { data: Body[] }).data).toHaveLength(0);
      await http()
        .get('/api/payments')
        .query({ status: 'NOPE' })
        .set(operator.auth)
        .expect(422);

      const one = await http()
        .get(`/api/payments/${p.id}`)
        .set(operator.auth)
        .expect(200);
      expect(one.body).toMatchObject({
        id: p.id,
        bookingReference: b.reference,
      });
      await http()
        .get('/api/payments/00000000-0000-4000-8000-000000000000')
        .set(operator.auth)
        .expect(404);

      const refunds = await http()
        .get('/api/refunds')
        .query({ pageSize: 100 })
        .set(operator.auth)
        .expect(200);
      const r = (refunds.body as { data: Body[] }).data.find(
        (x) => x.paymentId === p.id,
      )!;
      expect(r).toMatchObject({
        bookingReference: b.reference,
        currency: 'PEN',
        amountCents: 1000,
        requestedBy: admin.user.email,
      });
      expect((refunds.body as { meta: Body }).meta.total).toBeGreaterThan(0);
    });
  });
});
