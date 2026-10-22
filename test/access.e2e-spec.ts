import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { BackgroundQueue } from '../src/common/queue/background-queue';
import { LogMailer } from '../src/modules/notifications/log-mailer';
import { MAILER } from '../src/modules/notifications/mailer';
import { billingBoleta, createCatalog, customerInput, rand } from './fixtures';
import { createTestApp, loginAs, TestSession } from './helpers';

type Body = Record<string, any>;

/** Correo lento: si la petición esperara al envío, se notaría en el tiempo de respuesta. */
class SlowMailer extends LogMailer {
  static readonly DELAY_MS = 400;
  async send(message: Parameters<LogMailer['send']>[0]) {
    await new Promise((resolve) => setTimeout(resolve, SlowMailer.DELAY_MS));
    return super.send(message);
  }
}

describe('"Mi reserva": the answer does not depend on whether a link is sent (e2e)', () => {
  let app: INestApplication<App>;
  let mailer: SlowMailer;
  let operator: TestSession;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await createTestApp((builder) =>
      builder.overrideProvider(MAILER).useValue(new SlowMailer()),
    );
    mailer = app.get<SlowMailer>(MAILER);
    operator = await loginAs(app, 'operator');
  });
  afterAll(async () => {
    await app.get(BackgroundQueue).drain();
    await app.close();
  });

  const timed = async (body: Body) => {
    const started = process.hrtime.bigint();
    await http().post('/api/public/bookings/access').send(body).expect(202);
    return Number(process.hrtime.bigint() - started) / 1e6;
  };

  it('answers fast and alike for a match, a wrong email and an unknown reference; the link is sent afterwards', async () => {
    const fx = await createCatalog(app);
    const dep = await fx.departure();
    const email = `acceso-${rand()}@example.com`;
    const created = await http()
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
    const reference = (created.body as Body).reference as string;
    const before = mailer.sent.length;

    // Calienta la conexión y las rutas antes de medir.
    await timed({ reference: 'DST-WARMUP', email: 'warm@example.com' });
    const match = await timed({ reference, email });
    const wrongEmail = await timed({ reference, email: 'otro@example.com' });
    const unknown = await timed({ reference: 'DST-ZZZZZZ', email });

    for (const ms of [match, wrongEmail, unknown]) {
      expect(ms).toBeLessThan(SlowMailer.DELAY_MS / 2);
    }
    expect(Math.abs(match - unknown)).toBeLessThan(SlowMailer.DELAY_MS / 2);
    // Nada salió todavía de forma síncrona con la petición…
    expect(
      mailer.sent.slice(before).filter((m) => m.template === 'booking_access'),
    ).toHaveLength(0);
    // …pero el enlace llega después, y solo al titular.
    await app.get(BackgroundQueue).drain();
    const sent = mailer.sent
      .slice(before)
      .filter((m) => m.template === 'booking_access');
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe(email);
  });
});
