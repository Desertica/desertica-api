import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  StreamableFile,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { PaginationQuery } from '../../common/pagination/pagination';
import { UuidPipe } from '../../common/pipes/id-pipes';
import type { AuthUser } from '../auth/auth.types';
import { CurrentUser, RequirePermission } from '../auth/decorators';
import { DisputesService } from './disputes.service';
import {
  CreateRefundDto,
  DisputesQuery,
  PaymentsQuery,
  UpdateDisputeDto,
} from './dto/admin.dto';
import { EvidenceService } from './evidence.service';
import { PaymentsAdminService } from './payments-admin.service';
import { RefundsService } from './refunds-admin.service';

@Controller()
export class PaymentsAdminController {
  constructor(
    private readonly payments: PaymentsAdminService,
    private readonly refunds: RefundsService,
    private readonly disputes: DisputesService,
    private readonly evidence: EvidenceService,
  ) {}

  @Get('payments')
  @RequirePermission('payments:read')
  listPayments(@Query() q: PaymentsQuery) {
    return this.payments.list(q);
  }

  @Get('payments/:id')
  @RequirePermission('payments:read')
  getPayment(@Param('id', UuidPipe) id: string) {
    return this.payments.get(id);
  }

  @Post('payments/:id/refunds')
  @RequirePermission('payments:refund')
  async createRefund(
    @Param('id', UuidPipe) id: string,
    @Body() dto: CreateRefundDto,
    @Headers('idempotency-key') key: string | undefined,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    const result = await this.refunds.create(id, dto, user, {
      ip: req.ip,
      idempotencyKey: key,
    });
    return result.body;
  }

  @Get('refunds')
  @RequirePermission('payments:read')
  listRefunds(@Query() q: PaginationQuery) {
    return this.refunds.list(q);
  }

  @Post('refunds/:id/complete')
  @HttpCode(200)
  @RequirePermission('payments:refund')
  completeRefund(
    @Param('id', UuidPipe) id: string,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    return this.refunds.complete(id, user, req.ip);
  }

  @Get('disputes')
  @RequirePermission('payments:read')
  listDisputes(@Query() q: DisputesQuery) {
    return this.disputes.list(q);
  }

  @Get('disputes/:id')
  @RequirePermission('payments:read')
  getDispute(@Param('id', UuidPipe) id: string) {
    return this.disputes.get(id);
  }

  @Patch('disputes/:id')
  @RequirePermission('payments:write')
  updateDispute(
    @Param('id', UuidPipe) id: string,
    @Body() dto: UpdateDisputeDto,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    return this.disputes.update(id, dto, user, req.ip);
  }

  @Get('disputes/:id/evidence')
  @RequirePermission('payments:read')
  async downloadDisputeEvidence(
    @Param('id', UuidPipe) id: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { filename, data } = await this.evidence.build(id);
    // Las cabeceras van aquí y no como decorador: un error (404) debe seguir siendo JSON.
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return new StreamableFile(data);
  }
}
