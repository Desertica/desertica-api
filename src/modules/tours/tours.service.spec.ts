import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../../prisma/prisma.service';
import { ToursService } from './tours.service';

const tour = {
  id: '11111111-1111-4111-8111-111111111111',
  slug: 'dunas-al-atardecer',
  title: 'Dunas al atardecer',
  description: null,
  priceCents: 85000,
  currency: 'MXN',
  durationHours: 4,
  isPublished: true,
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-01-01'),
};

describe('ToursService', () => {
  let service: ToursService;
  const prisma = {
    tour: {
      create: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [ToursService, { provide: PrismaService, useValue: prisma }],
    }).compile();

    service = module.get(ToursService);
  });

  it('creates a tour', async () => {
    prisma.tour.create.mockResolvedValue(tour);

    await expect(
      service.create({
        slug: tour.slug,
        title: tour.title,
        priceCents: tour.priceCents,
        durationHours: tour.durationHours,
      }),
    ).resolves.toEqual(tour);
  });

  it('throws when a tour does not exist', async () => {
    prisma.tour.findUnique.mockResolvedValue(null);

    await expect(service.findOne(tour.id)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
