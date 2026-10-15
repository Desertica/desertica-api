import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { rateLimit } from '../../common/throttle';
import type { Request } from 'express';
import { IntIdPipe } from '../../common/pipes/id-pipes';
import type { AuthUser } from '../auth/auth.types';
import { CurrentUser, Public, RequirePermission } from '../auth/decorators';
import { ComplaintsService } from './complaints.service';
import {
  AnswerComplaintDto,
  ComplaintQuery,
  ContactMessageDto,
  CreateComplaintDto,
  LocaleQuery,
  PublishLegalDto,
  RecordConsentDto,
  LegalDocumentQuery,
  SignWaiverDto,
  WaiverQuery,
} from './dto/compliance.dto';
import { LegalService } from './legal.service';
import { PublicComplianceService } from './public-compliance.service';
import { WaiversService } from './waivers.service';

@Controller('complaints')
export class ComplaintsController {
  constructor(private readonly complaints: ComplaintsService) {}

  @Get()
  @RequirePermission('complaints:read')
  list(@Query() q: ComplaintQuery) {
    return this.complaints.list(q);
  }

  @Get(':id')
  @RequirePermission('complaints:read')
  get(@Param('id', IntIdPipe) id: number) {
    return this.complaints.get(id);
  }

  @Post(':id/answer')
  @HttpCode(200)
  @RequirePermission('complaints:write')
  answer(
    @Param('id', IntIdPipe) id: number,
    @Body() dto: AnswerComplaintDto,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    return this.complaints.answer(id, dto, user.id, req.ip);
  }
}

@Controller()
export class StaffComplianceController {
  constructor(
    private readonly waivers: WaiversService,
    private readonly legal: LegalService,
  ) {}

  @Get('waivers')
  @RequirePermission('waivers:read')
  listWaivers(@Query() q: WaiverQuery) {
    return this.waivers.list(q);
  }

  @Get('legal-documents')
  @RequirePermission('catalog:read')
  listLegal(@Query() q: LegalDocumentQuery) {
    return this.legal.list(q);
  }

  @Post('legal-documents')
  @RequirePermission('legal:write')
  publishLegal(
    @Body() dto: PublishLegalDto,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    return this.legal.publish(dto, user.id, req.ip);
  }
}

@Public()
@Controller('public')
export class PublicComplianceController {
  constructor(
    private readonly waivers: WaiversService,
    private readonly complaints: ComplaintsService,
    private readonly misc: PublicComplianceService,
    private readonly legal: LegalService,
  ) {}

  @Get('waivers/:token')
  @Throttle(rateLimit(30, 60_000))
  waiverForm(@Param('token') token: string) {
    return this.waivers.form(token);
  }

  @Post('waivers/:token/sign')
  @HttpCode(200)
  @Throttle(rateLimit(10, 60_000))
  signWaiver(
    @Param('token') token: string,
    @Body() dto: SignWaiverDto,
    @Req() req: Request,
  ) {
    return this.waivers.sign(token, dto, req.ip);
  }

  @Post('complaints')
  @Throttle(rateLimit(5, 3_600_000))
  createComplaint(@Body() dto: CreateComplaintDto, @Req() req: Request) {
    return this.complaints.create(dto, { ip: req.ip });
  }

  @Post('contact-messages')
  @HttpCode(202)
  @Throttle(rateLimit(5, 600_000))
  async createContactMessage(
    @Body() dto: ContactMessageDto,
    @Req() req: Request,
  ): Promise<void> {
    await this.misc.contact(dto, req.ip);
  }

  @Post('consents')
  @HttpCode(204)
  @Throttle(rateLimit(30, 60_000))
  async recordConsent(
    @Body() dto: RecordConsentDto,
    @Req() req: Request,
  ): Promise<void> {
    await this.misc.recordConsent(dto, req.ip);
  }

  @Get('legal-documents/current')
  currentLegal(@Query() q: LocaleQuery) {
    return this.legal.current(q.locale);
  }
}
