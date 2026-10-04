import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client';
import { ensureSystemRoles } from '../src/modules/roles/system-roles';

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error('DATABASE_URL is required to seed the database');
}

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString }),
});

/** Datos de desarrollo. El catálogo real se sincroniza desde el CMS (POST /tour-refs/sync). */
async function main() {
  await ensureSystemRoles(prisma);

  // Primer administrador: debe pertenecer a ALLOWED_EMAIL_DOMAIN para poder entrar con Google.
  const adminEmail = (
    process.env.SEED_ADMIN_EMAIL ??
    `admin@${process.env.ALLOWED_EMAIL_DOMAIN ?? 'desertica.pe'}`
  ).toLowerCase();
  const adminRole = await prisma.role.findUniqueOrThrow({
    where: { key: 'admin' },
  });
  await prisma.user.upsert({
    where: { email: adminEmail },
    update: {},
    create: { email: adminEmail, name: 'Administrador', roleId: adminRole.id },
  });

  let policy = await prisma.cancellationPolicy.findUnique({
    where: { key_version: { key: 'standard', version: 1 } },
  });
  policy ??= await prisma.cancellationPolicy.create({
    data: {
      key: 'standard',
      name: 'Estándar',
      tiers: [
        { hoursBefore: 48, refundPercent: 100 },
        { hoursBefore: 24, refundPercent: 50 },
        { hoursBefore: 0, refundPercent: 0 },
      ],
      depositRefundable: false,
    },
  });

  const tours = [
    {
      slug: 'dune-buggy',
      title: 'Dune Buggy',
      durationHours: 2,
      usd: 4500,
      pen: 16500,
    },
    {
      slug: 'sandboarding',
      title: 'Sandboarding',
      durationHours: 2,
      usd: 3000,
      pen: 11000,
    },
  ];
  const now = new Date();
  for (const tour of tours) {
    const ref = await prisma.tourRef.upsert({
      where: { slug: tour.slug },
      update: {},
      create: {
        slug: tour.slug,
        title: tour.title,
        durationHours: tour.durationHours,
        defaultCapacity: 12,
        cancellationPolicyId: policy.id,
        cmsSyncedAt: now,
      },
    });

    if (
      (await prisma.priceRule.count({ where: { tourRefId: ref.id } })) === 0
    ) {
      await prisma.priceRule.createMany({
        data: [
          {
            tourRefId: ref.id,
            currency: 'USD',
            adultCents: tour.usd,
            childCents: Math.round(tour.usd * 0.8),
          },
          {
            tourRefId: ref.id,
            currency: 'PEN',
            adultCents: tour.pen,
            childCents: Math.round(tour.pen * 0.8),
          },
        ],
      });
    }

    // Salidas de los próximos 14 días a las 09:00 y 16:00 de Lima (UTC-5).
    for (let day = 1; day <= 14; day++) {
      for (const hourLima of [9, 16]) {
        const startsAt = new Date(
          Date.UTC(
            now.getUTCFullYear(),
            now.getUTCMonth(),
            now.getUTCDate() + day,
            hourLima + 5,
          ),
        );
        await prisma.departure.upsert({
          where: {
            tourRefId_startsAt_format_language: {
              tourRefId: ref.id,
              startsAt,
              format: 'SHARED',
              language: 'es',
            },
          },
          update: {},
          create: {
            tourRefId: ref.id,
            startsAt,
            capacity: 12,
            meetingPoint: 'Oasis de Huacachina',
          },
        });
      }
    }
  }
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
