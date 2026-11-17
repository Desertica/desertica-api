import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { encryptField, isEncrypted } from '../../common/crypto/field-crypto';
import { EnvVars } from '../../config/env.validation';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { isValidDocument } from '../bookings/booking-support';
import { toWaiverDto } from '../bookings/booking.mappers';
import { SignWaiverDto, WaiverQuery } from './dto/compliance.dto';

/** Días después del inicio del tour en que el descargo todavía se puede firmar. */
export const WAIVER_SIGN_GRACE_DAYS = 2;

@Injectable()
export class WaiversService implements OnApplicationBootstrap {
  private readonly logger = new Logger(WaiversService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<EnvVars, true>,
  ) {}

  private get dataKey(): string {
    return this.config.get('DATA_ENCRYPTION_KEY', { infer: true });
  }

  /** Cifra las notas médicas guardadas antes del cifrado. Idempotente. */
  async onApplicationBootstrap(): Promise<void> {
    const legacy = await this.prisma.waiver.findMany({
      where: {
        medicalNotes: { not: null },
        NOT: { medicalNotes: { startsWith: 'enc:v1:' } },
      },
      select: { id: true, medicalNotes: true },
    });
    for (const w of legacy) {
      if (!w.medicalNotes || isEncrypted(w.medicalNotes)) continue;
      // Condición sobre el valor leído: no pisa una escritura simultánea.
      await this.prisma.waiver.updateMany({
        where: { id: w.id, medicalNotes: w.medicalNotes },
        data: { medicalNotes: encryptField(this.dataKey, w.medicalNotes) },
      });
    }
    if (legacy.length > 0) {
      this.logger.log(`Encrypted medical notes of ${legacy.length} waivers`);
    }
  }

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
        legalDocument: true,
        booking: { include: { departure: true, customer: true } },
      },
    });
    if (!waiver) throw new NotFoundException('Waiver not found');
    return waiver;
  }

  private toForm(w: Awaited<ReturnType<WaiversService['load']>>) {
    return {
      status: w.status,
      version: w.version,
      // El texto que se firma es el snapshot inmutable al que apunta el descargo.
      locale: w.legalDocument?.locale ?? null,
      title: w.legalDocument?.title ?? null,
      body: w.legalDocument?.textSnapshot ?? null,
      contentHash: w.legalDocument?.contentHash ?? null,
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
    // Un cliente borrado no vuelve a dejar datos, y un descargo no se firma meses después del tour.
    if (waiver.booking.customer.erasedAt) {
      throw new NotFoundException('Waiver not found');
    }
    const closesAt =
      waiver.booking.departure.startsAt.getTime() +
      WAIVER_SIGN_GRACE_DAYS * 86_400_000;
    if (Date.now() > closesAt) {
      throw new ConflictException('The waiver can no longer be signed');
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
        medicalNotes: dto.medicalNotes
          ? encryptField(this.dataKey, dto.medicalNotes)
          : null,
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
