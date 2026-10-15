import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { hashLegalText } from '../src/modules/compliance/legal.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { TestSession } from './helpers';

export const rand = () => Math.random().toString(36).slice(2, 8);

export const HOUR = 3_600_000;
export const inHours = (h: number) => new Date(Date.now() + h * HOUR);

export interface CatalogFixture {
  tour: { id: string; slug: string };
  policyId: string;
  /** Crea una salida del tour. */
  departure: (opts?: {
    startsAt?: Date;
    capacity?: number;
    cutoffMinutes?: number;
    format?: 'SHARED' | 'PRIVATE';
  }) => Promise<{ id: string; startsAt: Date }>;
}

/**
 * Tour con política (48 h → 100 %, 24 h → 50 %, 0 → 0 %), precios en USD y PEN
 * (adulto 100,00 / niño 60,00 y 360,00 / 200,00) y salidas bajo demanda.
 */
export async function createCatalog(
  app: INestApplication<App>,
  opts: { requiresWaiver?: boolean; depositRefundable?: boolean } = {},
): Promise<CatalogFixture> {
  const prisma = app.get(PrismaService);
  const policy = await prisma.cancellationPolicy.create({
    data: {
      key: `fx-${rand()}-${rand()}`,
      name: 'Fixture',
      tiers: [
        { hoursBefore: 48, refundPercent: 100 },
        { hoursBefore: 24, refundPercent: 50 },
        { hoursBefore: 0, refundPercent: 0 },
      ],
      depositRefundable: opts.depositRefundable ?? false,
    },
  });
  const slug = `fx-${rand()}-${rand()}`;
  const tour = await prisma.tourRef.create({
    data: {
      slug,
      title: `Fixture ${slug}`,
      durationHours: 2,
      requiresWaiver: opts.requiresWaiver ?? true,
      cancellationPolicyId: policy.id,
    },
  });
  if (opts.requiresWaiver ?? true) {
    // Sin un texto de descargo publicado el tour no se puede reservar.
    await publishWaiverSnapshot(prisma, tour);
  }
  await prisma.priceRule.createMany({
    data: [
      {
        tourRefId: tour.id,
        currency: 'USD',
        adultCents: 10000,
        childCents: 6000,
      },
      {
        tourRefId: tour.id,
        currency: 'PEN',
        adultCents: 36000,
        childCents: 20000,
      },
    ],
  });
  let n = 0;
  return {
    tour: { id: tour.id, slug },
    policyId: policy.id,
    departure: async (o = {}) => {
      const startsAt =
        o.startsAt ?? new Date(inHours(24 * 10).getTime() + n++ * 60_000);
      const d = await prisma.departure.create({
        data: {
          tourRefId: tour.id,
          startsAt,
          capacity: o.capacity ?? 10,
          cutoffMinutes: o.cutoffMinutes ?? 0,
          format: o.format ?? 'SHARED',
          meetingPoint: 'Plaza de Armas',
        },
      });
      return { id: d.id, startsAt: d.startsAt };
    },
  };
}

/** Inserta el snapshot del descargo de un tour (versión 1, en inglés, que sirve de respaldo a cualquier idioma). */
export async function publishWaiverSnapshot(
  prisma: PrismaService,
  tour: { id: string; slug: string },
  locale = 'en',
) {
  const body = `# Descargo de ${tour.slug}\n\nTexto del descargo.`;
  const title = `Descargo ${tour.slug}`;
  const last = await prisma.legalDocument.findFirst({
    where: { kind: 'WAIVER', locale, tourRefId: tour.id },
    orderBy: { version: 'desc' },
  });
  return prisma.legalDocument.create({
    data: {
      kind: 'WAIVER',
      locale,
      version: (last?.version ?? 0) + 1,
      tourRefId: tour.id,
      scopeKey: tour.id,
      cmsSlug: tour.slug,
      title,
      textSnapshot: body,
      contentHash: hashLegalText(title, body),
      publishedAt: new Date(),
    },
  });
}

/** Publica TERMS, PRIVACY y CANCELLATION en un idioma de pruebas y devuelve sus ids. */
export async function publishLegal(
  app: INestApplication<App>,
  admin: TestSession,
  locale: string,
): Promise<string[]> {
  const ids: string[] = [];
  for (const kind of ['TERMS', 'PRIVACY', 'CANCELLATION']) {
    const res = await request(app.getHttpServer())
      .post('/api/legal-documents')
      .set(admin.auth)
      .send({ kind, locale, cmsSlug: kind.toLowerCase() })
      .expect(201);
    ids.push((res.body as { id: string }).id);
  }
  return ids;
}

export const customerInput = (over: Record<string, unknown> = {}) => ({
  email: `cliente-${rand()}@example.com`,
  firstName: 'Ana',
  lastName: 'Pérez',
  phone: '+51999888777',
  country: 'PE',
  idDocType: 'DNI',
  idDocNumber: '12345678',
  ...over,
});

export const billingBoleta = {
  docType: 'BOLETA',
  name: 'Ana Pérez',
  idDocType: 'DNI',
  idDocNumber: '12345678',
};
