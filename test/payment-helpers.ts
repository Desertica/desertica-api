import { INestApplication } from '@nestjs/common';
import { inflateRawSync, crc32 } from 'node:zlib';
import request from 'supertest';
import { App } from 'supertest/types';
import { BookingAccessService } from '../src/modules/bookings/booking-access.service';
import { signFakeEvent } from '../src/modules/payments/providers/fake.gateway';
import type { GatewayEvent } from '../src/modules/payments/providers/payment-gateway';
import { PrismaService } from '../src/prisma/prisma.service';
import { billingBoleta, CatalogFixture, customerInput, rand } from './fixtures';

export interface DirectBooking {
  id: string;
  reference: string;
  token: string;
  total: number;
  currency: 'USD' | 'PEN';
}

/**
 * Reserva creada directo en la base (con su token de "mi reserva"). Los
 * e2e de pagos, reembolsos y comprobantes no dependen de que
 * `POST /public/bookings` ya cumpla el contrato.
 */
export async function makeBooking(
  app: INestApplication<App>,
  fx: CatalogFixture,
  over: {
    currency?: 'USD' | 'PEN';
    adults?: number;
    deposit?: boolean;
    departureId?: string;
    billing?: object;
    status?: 'PENDING_PAYMENT' | 'CONFIRMED';
  } = {},
): Promise<DirectBooking> {
  const prisma = app.get(PrismaService);
  const dep = over.departureId ?? (await fx.departure({ capacity: 10 })).id;
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
    data: { ...customerInput(), idDocType: 'DNI' },
  });
  const row = await prisma.booking.create({
    data: {
      reference: `DST-${rand().toUpperCase()}${rand().toUpperCase()}`.slice(
        0,
        10,
      ),
      status: over.status ?? 'PENDING_PAYMENT',
      source: 'WEB',
      departureId: dep,
      customerId: customer.id,
      holdId: hold.id,
      currency,
      adults,
      totalCents: total,
      depositCents: over.deposit ? Math.round(total * 0.3) : null,
      priceSnapshot: {},
      cancellationSnapshot: { tiers: [] },
      billing: over.billing ?? billingBoleta,
    },
  });
  const token = await app
    .get(BookingAccessService)
    .issue(prisma, row.id, departure.startsAt);
  return { id: row.id, reference: row.reference, token, total, currency };
}

/**
 * Pago de pasarela ya acreditado, escrito directo (sin pasar por el
 * webhook): deja la reserva confirmada y pagada por `amountCents`.
 */
export async function recordPaid(
  app: INestApplication<App>,
  booking: DirectBooking,
  over: {
    provider?: 'STRIPE' | 'CULQI' | 'MANUAL';
    amountCents?: number;
    kind?: 'FULL' | 'DEPOSIT' | 'BALANCE';
  } = {},
) {
  const prisma = app.get(PrismaService);
  const amountCents = over.amountCents ?? booking.total;
  const provider = over.provider ?? 'STRIPE';
  const payment = await prisma.payment.create({
    data: {
      bookingId: booking.id,
      provider,
      method: provider === 'MANUAL' ? 'CASH' : 'CARD',
      kind: over.kind ?? 'FULL',
      status: 'SUCCEEDED',
      currency: booking.currency,
      amountCents,
      providerRef:
        provider === 'MANUAL'
          ? null
          : `${provider === 'STRIPE' ? 'pi' : 'chr'}_t_${rand()}${rand()}`,
      paidAt: new Date(),
    },
  });
  await prisma.booking.update({
    where: { id: booking.id },
    data: { paidCents: { increment: amountCents }, status: 'CONFIRMED' },
  });
  return payment;
}

/** Envía un webhook simulado (firmado salvo `tamper`). */
export function postWebhook(
  app: INestApplication<App>,
  provider: 'stripe' | 'culqi',
  event: GatewayEvent,
  tamper = false,
) {
  const signed = signFakeEvent(event);
  return request(app.getHttpServer())
    .post(`/api/webhooks/${provider}`)
    .set({
      ...signed.headers,
      ...(tamper ? { 'x-fake-signature': 'deadbeef' } : {}),
    })
    .send(signed.body);
}

export const evt = () => `evt_${rand()}${rand()}`;

/** Lector mínimo de ZIP (por el directorio central) para las pruebas. */
export function readZip(zip: Buffer): Map<string, Buffer> {
  const eocd = zip.length - 22;
  if (zip.readUInt32LE(eocd) !== 0x06054b50) throw new Error('Not a ZIP');
  const count = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  const files = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    const method = zip.readUInt16LE(p + 10);
    const crc = zip.readUInt32LE(p + 16);
    const compSize = zip.readUInt32LE(p + 20);
    const nameLen = zip.readUInt16LE(p + 28);
    const local = zip.readUInt32LE(p + 42);
    const name = zip.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    const start =
      local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const raw = zip.subarray(start, start + compSize);
    const data = Buffer.from(method === 8 ? inflateRawSync(raw) : raw);
    if (crc32(data) !== crc) throw new Error(`Bad CRC for ${name}`);
    files.set(name, data);
    p += 46 + nameLen;
  }
  return files;
}

/**
 * Empresa activa con series de boleta, factura y notas de crédito. Idempotente:
 * usa la empresa activa que ya exista (la base de pruebas se comparte) y crea
 * solo las series que falten.
 */
export async function ensureBilling(app: INestApplication<App>) {
  const prisma = app.get(PrismaService);
  const company =
    (await prisma.company.findFirst({
      where: { active: true },
      orderBy: { createdAt: 'asc' },
    })) ??
    (await prisma.company.create({
      data: {
        ruc: `20${Math.floor(Math.random() * 1e9)
          .toString()
          .padStart(9, '0')}`,
        legalName: 'Desertica SAC (pruebas)',
        fiscalAddress: 'Av. Los Médanos 1, Ica',
        environment: 'BETA',
      },
    }));
  const wanted = [
    ['BOLETA', 'B001'],
    ['FACTURA', 'F001'],
    ['NOTA_CREDITO', 'BC01'],
    ['NOTA_CREDITO', 'FC01'],
  ] as const;
  for (const [docType, prefix] of wanted) {
    const exists = await prisma.series.findFirst({
      where: {
        companyId: company.id,
        docType,
        active: true,
        prefix: { startsWith: prefix[0] },
      },
    });
    if (!exists) {
      await prisma.series.upsert({
        where: { companyId_prefix: { companyId: company.id, prefix } },
        update: { active: true },
        create: { companyId: company.id, docType, prefix, nextNumber: 1 },
      });
    }
  }
  return company;
}
