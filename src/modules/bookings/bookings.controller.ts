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
} from '@nestjs/common';
import type { Request } from 'express';
import { UuidPipe } from '../../common/pipes/id-pipes';
import type { AuthUser } from '../auth/auth.types';
import { CurrentUser, RequirePermission } from '../auth/decorators';
import { BookingCreationService } from './booking-creation.service';
import { BookingLifecycleService } from './booking-lifecycle.service';
import { BookingPaymentsService } from './booking-payments.service';
import { BookingViewService } from './booking-view.service';
import {
  BookingQuery,
  CancelBookingDto,
  CreateManualBookingDto,
  CreatePaymentLinkDto,
  ManualPaymentDto,
  RescheduleBookingDto,
  SetBookingStatusDto,
  UpdateBookingDto,
} from './dto/booking.dto';

@Controller('bookings')
export class BookingsController {
  constructor(
    private readonly view: BookingViewService,
    private readonly creation: BookingCreationService,
    private readonly lifecycle: BookingLifecycleService,
    private readonly payments: BookingPaymentsService,
  ) {}

  @Get()
  @RequirePermission('bookings:read')
  list(@Query() q: BookingQuery) {
    return this.view.list(q);
  }

  @Post()
  @RequirePermission('bookings:write')
  async createManual(
    @Body() dto: CreateManualBookingDto,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') key: string | undefined,
    @Req() req: Request,
  ) {
    const result = await this.creation.createManual(dto, user, {
      ip: req.ip,
      idempotencyKey: key,
    });
    return result.body;
  }

  @Get(':id')
  @RequirePermission('bookings:read')
  get(@Param('id', UuidPipe) id: string) {
    return this.view.get(id);
  }

  @Patch(':id')
  @RequirePermission('bookings:write')
  update(
    @Param('id', UuidPipe) id: string,
    @Body() dto: UpdateBookingDto,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    return this.lifecycle.update(id, dto, user, req.ip);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @RequirePermission('bookings:cancel')
  cancel(
    @Param('id', UuidPipe) id: string,
    @Body() dto: CancelBookingDto,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    return this.lifecycle.cancel(id, dto, user, req.ip);
  }

  @Post(':id/reschedule')
  @HttpCode(200)
  @RequirePermission('bookings:write')
  reschedule(
    @Param('id', UuidPipe) id: string,
    @Body() dto: RescheduleBookingDto,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    return this.lifecycle.reschedule(id, dto, user, req.ip);
  }

  @Post(':id/status')
  @HttpCode(200)
  @RequirePermission('bookings:write')
  setStatus(
    @Param('id', UuidPipe) id: string,
    @Body() dto: SetBookingStatusDto,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    return this.lifecycle.setStatus(id, dto, user, req.ip);
  }

  @Post(':id/payment-links')
  @RequirePermission('payments:write')
  createPaymentLink(
    @Param('id', UuidPipe) id: string,
    @Body() dto: CreatePaymentLinkDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.payments.createLink(id, dto, user);
  }

  @Post(':id/payments/manual')
  @RequirePermission('payments:write')
  async recordManualPayment(
    @Param('id', UuidPipe) id: string,
    @Body() dto: ManualPaymentDto,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') key: string | undefined,
    @Req() req: Request,
  ) {
    const result = await this.payments.recordManual(id, dto, user, {
      ip: req.ip,
      idempotencyKey: key,
    });
    return result.body;
  }
}
