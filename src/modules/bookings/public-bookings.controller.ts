import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { rateLimit } from '../../common/throttle';
import type { Request } from 'express';
import { Public } from '../auth/decorators';
import { BookingAccessService } from './booking-access.service';
import { BookingCreationService } from './booking-creation.service';
import { BookingPaymentsService } from './booking-payments.service';
import { BookingViewService } from './booking-view.service';
import { PublicAccessService } from './public-access.service';
import {
  CreateHoldDto,
  CreatePublicBookingDto,
  RequestAccessDto,
} from './dto/booking.dto';
import { HoldsService } from './holds.service';

@Public()
@Controller('public')
export class PublicBookingsController {
  constructor(
    private readonly holds: HoldsService,
    private readonly creation: BookingCreationService,
    private readonly access: BookingAccessService,
    private readonly publicAccess: PublicAccessService,
    private readonly view: BookingViewService,
    private readonly payments: BookingPaymentsService,
  ) {}

  @Post('holds')
  @Throttle(rateLimit(10, 60_000))
  createHold(@Body() dto: CreateHoldDto) {
    return this.holds.create(dto.departureId, dto.seats);
  }

  @Delete('holds/:token')
  @HttpCode(204)
  async releaseHold(@Param('token') token: string): Promise<void> {
    await this.holds.release(token);
  }

  @Post('bookings')
  @Throttle(rateLimit(10, 60_000))
  async createBooking(
    @Body() dto: CreatePublicBookingDto,
    @Headers('idempotency-key') key: string | undefined,
    @Headers('user-agent') userAgent: string | undefined,
    @Req() req: Request,
  ) {
    const result = await this.creation.createPublic(dto, {
      ip: req.ip,
      userAgent,
      idempotencyKey: key,
    });
    return result.body;
  }

  // Declarado antes de `bookings/:reference` para que "access" no sea una referencia.
  @Post('bookings/access')
  @HttpCode(202)
  @Throttle(rateLimit(5, 60_000))
  async requestAccess(@Body() dto: RequestAccessDto): Promise<void> {
    await this.publicAccess.request(dto.reference, dto.email);
  }

  @Get('bookings/:reference')
  async getBooking(
    @Param('reference') reference: string,
    @Headers('x-booking-token') token: string | undefined,
  ) {
    const bookingId = await this.access.authenticate(reference, token);
    return this.view.toPublicById(bookingId);
  }

  @Get('payment-links/:token')
  linkInfo(@Param('token') token: string) {
    return this.payments.linkInfo(token);
  }
}
