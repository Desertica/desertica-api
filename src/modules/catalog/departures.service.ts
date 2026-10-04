import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { paginated, skipTake } from '../../common/pagination/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { toDepartureDto } from './catalog.mappers';
import {
  CreateDepartureDto,
  DepartureQuery,
  UpdateDepartureDto,
} from './dto/catalog.dto';
import { SeatsService } from './seats.service';
import { expandSeries, MAX_SERIES } from './series';

@Injectable()
export class DeparturesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly seats: SeatsService,
    private readonly audit: AuditService,
  ) {}

  async list(q: DepartureQuery) {
    const where: Prisma.DepartureWhereInput = {
      ...(q.tourRefId ? { tourRefId: q.tourRefId } : {}),
      ...(q.status ? { status: q.status } : {}),
      ...(q.from || q.to
        ? {
            startsAt: {
              ...(q.from ? { gte: new Date(q.from) } : {}),
              ...(q.to ? { lt: new Date(q.to) } : {}),
            },
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.departure.findMany({
        where,
        orderBy: { startsAt: 'asc' },
        ...skipTake(q),
      }),
      this.prisma.departure.count({ where }),
    ]);
    const counts = await this.seats.countFor(rows.map((r) => r.id));
    return paginated(
      rows.map((r) => toDepartureDto(r, counts.get(r.id))),
      q,
      total,
    );
  }

  async get(id: string) {
    const row = await this.prisma.departure.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Departure not found');
    const counts = await this.seats.countFor([id]);
    return toDepartureDto(row, counts.get(id));
  }

  async create(dto: CreateDepartureDto, actorId: string, ip?: string) {
    const tour = await this.prisma.tourRef.findUnique({
      where: { id: dto.tourRefId },
    });
    if (!tour) throw new UnprocessableEntityException('Unknown tourRefId');
    if (!tour.active)
      throw new UnprocessableEntityException('Tour is inactive');

    const first = new Date(dto.startsAt);
    if (first.getTime() <= Date.now()) {
      throw new UnprocessableEntityException('startsAt must be in the future');
    }
    const starts = dto.repeat
      ? expandSeries(first, dto.repeat.until, dto.repeat.weekdays)
      : [first];
    if (starts.length === 0) {
      throw new UnprocessableEntityException('The series has no dates');
    }
    if (starts.length > MAX_SERIES) {
      throw new UnprocessableEntityException(
        `A series is limited to ${MAX_SERIES} departures`,
      );
    }

    const format = dto.format ?? 'SHARED';
    const language = dto.language ?? 'es';
    const clash = await this.prisma.departure.findMany({
      where: {
        tourRefId: dto.tourRefId,
        format,
        language,
        startsAt: { in: starts },
      },
      select: { startsAt: true },
    });
    if (clash.length > 0) {
      throw new ConflictException({
        message: 'Departures already exist for some dates',
        details: { startsAt: clash.map((c) => c.startsAt.toISOString()) },
      });
    }

    const created = await this.prisma.$transaction(async (tx) => {
      const rows = await Promise.all(
        starts.map((startsAt) =>
          tx.departure.create({
            data: {
              tourRefId: dto.tourRefId,
              startsAt,
              capacity: dto.capacity,
              format,
              language,
              meetingPoint: dto.meetingPoint,
              guideName: dto.guideName,
              vehicleNote: dto.vehicleNote,
              notes: dto.notes,
              cutoffMinutes: dto.cutoffMinutes ?? 0,
            },
          }),
        ),
      );
      await this.audit.record(
        {
          actorUserId: actorId,
          action: 'departure.create',
          entity: 'Departure',
          entityId: rows[0].id,
          after: { tourRefId: dto.tourRefId, count: rows.length },
          ip,
        },
        tx,
      );
      return rows;
    });
    return { data: created.map((d) => toDepartureDto(d)) };
  }

  async update(
    id: string,
    dto: UpdateDepartureDto,
    actorId: string,
    ip?: string,
  ) {
    const row = await this.prisma.$transaction(async (tx) => {
      if (!(await this.seats.lockDeparture(tx, id))) {
        throw new NotFoundException('Departure not found');
      }
      const before = await tx.departure.findUniqueOrThrow({ where: { id } });
      if (before.status === 'CANCELLED' || before.status === 'COMPLETED') {
        throw new ConflictException(`Departure is ${before.status}`);
      }
      if (dto.capacity !== undefined) {
        const sold = (await this.seats.countFor([id], new Date(), tx)).get(id)!;
        if (dto.capacity < sold.sold + sold.held) {
          throw new ConflictException({
            message: 'Capacity is below the seats already sold or held',
            details: { seatsSold: sold.sold, seatsHeld: sold.held },
          });
        }
      }
      const updated = await tx.departure.update({
        where: { id },
        data: {
          ...(dto.startsAt ? { startsAt: new Date(dto.startsAt) } : {}),
          capacity: dto.capacity,
          status: dto.status,
          meetingPoint: dto.meetingPoint,
          guideName: dto.guideName,
          vehicleNote: dto.vehicleNote,
          notes: dto.notes,
          cutoffMinutes: dto.cutoffMinutes,
        },
      });
      await this.audit.record(
        {
          actorUserId: actorId,
          action: 'departure.update',
          entity: 'Departure',
          entityId: id,
          before: toDepartureDto(before),
          after: toDepartureDto(updated),
          ip,
        },
        tx,
      );
      return updated;
    });
    const counts = await this.seats.countFor([id]);
    return toDepartureDto(row, counts.get(id));
  }
}
