import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CaptchaService } from '../../common/captcha/captcha.service';
import { EnvVars } from '../../config/env.validation';
import { toJson } from '../bookings/booking-support';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ContactMessageDto, RecordConsentDto } from './dto/compliance.dto';

@Injectable()
export class PublicComplianceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly captcha: CaptchaService,
    private readonly notifications: NotificationsService,
    private readonly config: ConfigService<EnvVars, true>,
  ) {}

  async recordConsent(dto: RecordConsentDto, ip?: string): Promise<void> {
    // Solo categorías con valor booleano y nombre simple.
    const categories: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(dto.categories)) {
      if (/^[a-z][A-Za-z0-9_]{0,30}$/.test(key) && typeof value === 'boolean') {
        categories[key] = value;
      }
    }
    await this.prisma.consentRecord.create({
      data: {
        anonymousId: dto.anonymousId,
        categories: toJson(categories),
        policyVersion: dto.policyVersion,
        ip: ip ?? null,
      },
    });
  }

  async contact(dto: ContactMessageDto, ip?: string): Promise<void> {
    await this.captcha.verify(dto.turnstileToken, ip);
    const message = await this.prisma.contactMessage.create({
      data: {
        name: dto.name.trim(),
        email: dto.email.trim().toLowerCase(),
        whatsapp: dto.whatsapp,
        country: dto.country,
        message: dto.message,
        locale: dto.locale,
        ip: ip ?? null,
      },
    });
    const staff = this.config.get('STAFF_NOTIFY_EMAIL', { infer: true });
    if (staff) {
      await this.notifications.sendEmail({
        to: staff,
        template: 'contact_message',
        data: {
          id: message.id,
          name: message.name,
          email: message.email,
          whatsapp: message.whatsapp,
          country: message.country,
          message: message.message,
        },
      });
    }
  }
}
