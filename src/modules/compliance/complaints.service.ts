import {
  ConflictException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CaptchaService } from '../../common/captcha/captcha.service';
import {
  KEY_VALUE_STORE,
  type KeyValueStore,
} from '../../common/cache/key-value-store';
import { paginated, skipTake } from '../../common/pagination/pagination';
import { addBusinessDays } from '../../common/time/lima';
import { EnvVars } from '../../config/env.validation';
import { Complaint, Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import {
  isValidDocument,
  normalizeEmail,
  sha256,
} from '../bookings/booking-support';
import { NotificationsService } from '../notifications/notifications.service';
import { SettingsService } from '../settings/settings.service';
import {
  AnswerComplaintDto,
  ComplaintQuery,
  CreateComplaintDto,
} from './dto/compliance.dto';
import { UnprocessableEntityException } from '@nestjs/common';

const u = <T>(v: T | null | undefined) => v ?? undefined;

export const toComplaintDto = (c: Complaint) => ({
  id: c.id,
  kind: c.kind,
  goodType: c.goodType,
  consumerName: c.consumerName,
  idDocType: c.idDocType,
  idDocNumber: c.idDocNumber,
  address: c.address,
  email: c.email,
  phone: u(c.phone),
  isMinor: c.isMinor,
  bookingRef: u(c.bookingRef),
  amountCents: u(c.amountCents),
  currency: u(c.currency),
  description: c.description,
  detail: c.detail,
  request: c.request,
  status: c.status,
  answer: c.answer,
  answeredAt: c.answeredAt,
  dueAt: c.dueAt,
  createdAt: c.createdAt,
});

@Injectable()
export class ComplaintsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly captcha: CaptchaService,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditService,
    private readonly config: ConfigService<EnvVars, true>,
    @Inject(KEY_VALUE_STORE) private readonly store: KeyValueStore,
  ) {}

  /**
   * Libro de Reclamaciones virtual. El correlativo es el id autoincremental y
   * el plazo se cuenta en días hábiles desde el registro. Una copia va al
   * correo del consumidor.
   */
  async create(
    dto: CreateComplaintDto,
    ctx: { ip?: string },
    now = new Date(),
  ) {
    await this.captcha.verify(dto.turnstileToken, ctx.ip);
    if (!isValidDocument(dto.idDocType, dto.idDocNumber)) {
      throw new UnprocessableEntityException(
        `idDocNumber is not a valid ${dto.idDocType}`,
      );
    }
    if ((dto.amountCents === undefined) !== (dto.currency === undefined)) {
      throw new UnprocessableEntityException(
        'amountCents and currency go together',
      );
    }
    // Un mismo correo no puede inundar el libro: 5 por día, sin revelar el límite.
    const email = normalizeEmail(dto.email);
    const hits = await this.store.incr(
      `complaint:email:${sha256(email)}`,
      86_400_000,
    );
    if (hits.value > 5) {
      throw new HttpException(
        'Too many complaints from this email today',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const dueDays = await this.settings.getNumber('complaintDueDays');
    const complaint = await this.prisma.$transaction(async (tx) => {
      const created = await tx.complaint.create({
        data: {
          kind: dto.kind,
          goodType: dto.goodType,
          consumerName: dto.consumerName.trim(),
          idDocType: dto.idDocType,
          idDocNumber: dto.idDocNumber,
          address: dto.address,
          email,
          phone: dto.phone,
          isMinor: dto.isMinor ?? false,
          bookingRef: dto.bookingRef,
          amountCents: dto.amountCents,
          currency: dto.currency,
          description: dto.description,
          detail: dto.detail,
          request: dto.request,
          dueAt: addBusinessDays(now, dueDays),
        },
      });
      await this.audit.record(
        {
          action: 'complaint.create',
          entity: 'Complaint',
          entityId: String(created.id),
          after: { kind: created.kind, dueAt: created.dueAt },
          ip: ctx.ip,
        },
        tx,
      );
      return created;
    });

    await this.notifications.sendEmail({
      to: complaint.email,
      template: 'complaint_received',
      data: {
        correlative: complaint.id,
        kind: complaint.kind,
        consumerName: complaint.consumerName,
        description: complaint.description,
        detail: complaint.detail,
        request: complaint.request,
        createdAt: complaint.createdAt.toISOString(),
        dueAt: complaint.dueAt.toISOString(),
      },
    });
    const staff = this.config.get('STAFF_NOTIFY_EMAIL', { infer: true });
    if (staff) {
      await this.notifications.sendEmail({
        to: staff,
        template: 'complaint_staff_alert',
        data: {
          correlative: complaint.id,
          dueAt: complaint.dueAt.toISOString(),
        },
      });
    }
    return { correlative: complaint.id, dueAt: complaint.dueAt };
  }

  async list(q: ComplaintQuery) {
    const where: Prisma.ComplaintWhereInput = q.status
      ? { status: q.status }
      : {};
    const [rows, total] = await Promise.all([
      this.prisma.complaint.findMany({
        where,
        orderBy: [{ status: 'asc' }, { dueAt: 'asc' }],
        ...skipTake(q),
      }),
      this.prisma.complaint.count({ where }),
    ]);
    return paginated(rows.map(toComplaintDto), q, total);
  }

  async get(id: number) {
    const row = await this.prisma.complaint.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Complaint not found');
    return toComplaintDto(row);
  }

  async answer(
    id: number,
    dto: AnswerComplaintDto,
    actorId: string,
    ip?: string,
  ) {
    const before = await this.prisma.complaint.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('Complaint not found');
    const answeredAt = new Date();
    const updated = await this.prisma.$transaction(async (tx) => {
      // La respuesta es evidencia del plazo legal: se da una sola vez.
      const claimed = await tx.complaint.updateMany({
        where: { id, status: { not: 'ANSWERED' } },
        data: { answer: dto.answer, answeredAt, status: 'ANSWERED' },
      });
      if (claimed.count !== 1) {
        throw new ConflictException('The complaint was already answered');
      }
      const row = await tx.complaint.findUniqueOrThrow({ where: { id } });
      await this.audit.record(
        {
          actorUserId: actorId,
          action: 'complaint.answer',
          entity: 'Complaint',
          entityId: String(id),
          before: { status: before.status },
          after: { status: 'ANSWERED', answeredAt },
          ip,
        },
        tx,
      );
      return row;
    });
    await this.notifications.sendEmail({
      to: updated.email,
      template: 'complaint_answered',
      data: {
        correlative: updated.id,
        consumerName: updated.consumerName,
        answer: dto.answer,
        answeredAt: answeredAt.toISOString(),
      },
    });
    return toComplaintDto(updated);
  }
}
