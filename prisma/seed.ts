import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client';

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error('DATABASE_URL is required to seed the database');
}

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString }),
});

async function main() {
  const duneSunset = await prisma.tour.upsert({
    where: { slug: 'dunas-al-atardecer' },
    update: {},
    create: {
      slug: 'dunas-al-atardecer',
      title: 'Dunas al atardecer',
      description:
        'Recorrido por las dunas de Desértica con parada para ver el atardecer.',
      priceCents: 85000,
      currency: 'MXN',
      durationHours: 4,
      isPublished: true,
    },
  });

  const stargazing = await prisma.tour.upsert({
    where: { slug: 'cielo-estrellado' },
    update: {},
    create: {
      slug: 'cielo-estrellado',
      title: 'Cielo estrellado',
      description: 'Observación nocturna de estrellas en el desierto.',
      priceCents: 120000,
      currency: 'MXN',
      durationHours: 5,
      isPublished: true,
    },
  });

  console.log({ duneSunset, stargazing });
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
