import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { SettingsService } from '../src/modules/settings/settings.service';
import {
  billingBoleta,
  CatalogFixture,
  createCatalog,
  customerInput,
  publishLegal,
} from './fixtures';
import { createTestApp, loginAs, TestSession } from './helpers';

type Body = Record<string, any>;
const N = 30;
const CAPACITY = 20;
// Idioma propio de cada corrida: los textos legales son inmutables.
const letter = () => String.fromCharCode(97 + Math.floor(Math.random() * 26));
const LOCALE = `q${letter()}-${letter()}${letter()}`.replace(
  /-(..)/,
  (_m, x: string) => `-${x.toUpperCase()}`,
);

/** Con el pool agotado por transacciones que piden una segunda conexión, esto devolvía 500. */
describe('Concurrencia sobre el pool de conexiones (e2e)', () => {
  let app: INestApplication<App>;
  let fx: CatalogFixture;
  let operator: TestSession;
  let legalIds: string[];
  const http = () => request(app.getHttpServer());
  const hold = (departureId: string) =>
    http().post('/api/public/holds').send({ departureId, seats: 1 });
  const statuses = (rs: { status: number }[]) => {
    const count = (s: number) => rs.filter((r) => r.status === s).length;
    return { created: count(201), conflict: count(409), total: rs.length };
  };

  beforeAll(async () => {
    app = await createTestApp();
    const admin = await loginAs(app, 'admin');
    operator = await loginAs(app, 'operator');
    legalIds = await publishLegal(app, admin, LOCALE);
    // El tope de bloqueos vigentes por salida (10) taparía la prueba con 429.
    await app.get(SettingsService).save({ maxActiveHoldsPerDeparture: 100 });
    fx = await createCatalog(app);
  });
  afterAll(async () => {
    await app.close();
  });

  it('grants holds until the departure is full and then answers 409, never 500', async () => {
    const dep = await fx.departure({ capacity: CAPACITY });
    const rs = await Promise.all(Array.from({ length: N }, () => hold(dep.id)));
    expect(statuses(rs)).toEqual({
      created: CAPACITY,
      conflict: N - CAPACITY,
      total: N,
    });
  });

  it('creates manual bookings until the departure is full and then answers 409, never 500', async () => {
    const dep = await fx.departure({ capacity: CAPACITY });
    const rs = await Promise.all(
      Array.from({ length: N }, () =>
        http().post('/api/bookings').set(operator.auth).send({
          departureId: dep.id,
          currency: 'USD',
          adults: 1,
          customer: customerInput(),
          billing: billingBoleta,
          sendConfirmation: false,
        }),
      ),
    );
    expect(statuses(rs)).toEqual({
      created: CAPACITY,
      conflict: N - CAPACITY,
      total: N,
    });
  });

  it('turns simultaneous holds into web bookings without exhausting the pool', async () => {
    const dep = await fx.departure({ capacity: N });
    const holds = await Promise.all(
      Array.from({ length: N }, () => hold(dep.id).expect(201)),
    );
    const rs = await Promise.all(
      holds.map((h) =>
        http()
          .post('/api/public/bookings')
          .send({
            holdToken: (h.body as Body).token,
            currency: 'USD',
            adults: 1,
            customer: customerInput({ locale: LOCALE }),
            billing: billingBoleta,
            paymentKind: 'FULL',
            acceptedLegalDocumentIds: legalIds,
            locale: LOCALE,
          }),
      ),
    );
    expect(statuses(rs)).toEqual({ created: N, conflict: 0, total: N });
  });
});
