import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateTourDto } from './dto/create-tour.dto';
import { UpdateTourDto } from './dto/update-tour.dto';

@Injectable()
export class ToursService {
  constructor(private readonly prisma: PrismaService) {}

  create(data: CreateTourDto) {
    return this.prisma.tour.create({ data });
  }

  findAll() {
    return this.prisma.tour.findMany({
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(id: string) {
    const tour = await this.prisma.tour.findUnique({ where: { id } });

    if (!tour) {
      throw new NotFoundException(`Tour ${id} not found`);
    }

    return tour;
  }

  async update(id: string, data: UpdateTourDto) {
    await this.findOne(id);
    return this.prisma.tour.update({ where: { id }, data });
  }

  async remove(id: string) {
    await this.findOne(id);
    return this.prisma.tour.delete({ where: { id } });
  }
}
