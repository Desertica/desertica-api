import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { isValidDocument } from '../bookings/booking-support';
import { toWaiverDto } from '../bookings/booking.mappers';
import { SignWaiverDto, WaiverQuery } from './dto/compliance.dto';

@Injectable()
export class WaiversService {
  constructor(private readonly prisma: PrismaService) {}

  async list(q: WaiverQuery) {
    const where: Prisma.WaiverWhereInput = {
      ...(q.bookingId ? { bookingId: q.bookingId } : {}),
      ...(q.status ? { status: q.status } : {}),
    };
    const rows = await this.prisma.waiver.findMany({
      where,
      orderBy: { createdAt: 'asc' },
      take: 500,
    });
    return { data: rows.map(toWaiverDto) };
  }

  private async load(token: string) {
    const waiver = await this.prisma.waiver.findUnique({
      where: { token },
      include: {
        passenger: true,
        tourRef: true,
        booking: { include: { departure: true } },
      },
    });
    if (!waiver) throw new NotFoundException('Waiver not found');
    return waiver;
  }

  private toForm(w: Awaited<ReturnType<WaiversService['load']>>) {
    return {
      status: w.status,
      version: w.version,
      tourSlug: w.tourRef.slug,
      startsAt: w.booking.departure.startsAt,
      passengerName: w.passenger
        ? `${w.passenger.firstName} ${w.passenger.lastName}`
        : null,
      minAge: w.tourRef.minAge,
      minHeightCm: w.tourRef.minHeightCm,
    };
  }

  async form(token: string) {
    return this.toForm(await this.load(token));
  }

  async sign(token: string, dto: SignWaiverDto, ip?: string) {
    if (!isValidDocument(dto.signerDocType, dto.signerDocNumber)) {
      throw new UnprocessableEntityException(
        `signerDocNumber is not a valid ${dto.signerDocType}`,
      );
    }
    const waiver = await this.load(token);
    if (waiver.booking.status === 'CANCELLED') {
      throw new ConflictException('The booking was cancelled');
    }
    // Firma única: la condición `status = PENDING` hace que dos firmas simultáneas no pisen la primera.
    const signedAt = new Date();
    const claimed = await this.prisma.waiver.updateMany({
      where: { id: waiver.id, status: 'PENDING' },
      data: {
        status: 'SIGNED',
        signerName: dto.signerName.trim(),
        signerDocType: dto.signerDocType,
        signerDocNumber: dto.signerDocNumber,
        onBehalfOfMinor: dto.onBehalfOfMinor ?? false,
        medicalNotes: dto.medicalNotes ?? null,
        signedAt,
        ip: ip ?? null,
      },
    });
    if (claimed.count !== 1)
      throw new ConflictException('The waiver was already signed');

    if (
      waiver.passengerId &&
      (dto.emergencyContactName || dto.emergencyContactPhone)
    ) {
      await this.prisma.passenger.update({
        where: { id: waiver.passengerId },
        data: {
          ...(dto.emergencyContactName
            ? { emergencyContactName: dto.emergencyContactName }
            : {}),
          ...(dto.emergencyContactPhone
            ? { emergencyContactPhone: dto.emergencyContactPhone }
            : {}),
        },
      });
    }
    return this.toForm(await this.load(token));
  }
}
