import { Body, Controller, Headers, Param, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { rateLimit } from '../../common/throttle';
import { Public } from '../auth/decorators';
import { BookingAccessService } from '../bookings/booking-access.service';
import {
  CreatePaymentDto,
  CulqiChargeDto,
  LinkCulqiChargeDto,
} from './dto/payments.dto';
import { PaymentsService } from './payments.service';

/**
 * Cobros del cliente. Anónimos: el acceso es el token de "mi reserva"
 * (`X-Booking-Token`) o el token del enlace de pago. Limitados por IP y con
 * `Idempotency-Key`.
 */
@Public()
@Controller('public')
export class PublicPaymentsController {
  constructor(
    private readonly payments: PaymentsService,
    private readonly access: BookingAccessService,
  ) {}

  @Post('bookings/:reference/payments/stripe-intent')
  @Throttle(rateLimit(10, 60_000))
  async bookingStripeIntent(
    @Param('reference') reference: string,
    @Headers('x-booking-token') token: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Body() dto: CreatePaymentDto,
  ) {
    const bookingId = await this.access.authenticate(reference, token);
    return this.payments.bookingStripeIntent(bookingId, dto.kind, key);
  }

  @Post('bookings/:reference/payments/culqi-charge')
  @Throttle(rateLimit(10, 60_000))
  async bookingCulqiCharge(
    @Param('reference') reference: string,
    @Headers('x-booking-token') token: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Body() dto: CulqiChargeDto,
  ) {
    const bookingId = await this.access.authenticate(reference, token);
    return this.payments.bookingCulqiCharge(bookingId, dto.kind, dto, key);
  }

  @Post('payment-links/:token/stripe-intent')
  @Throttle(rateLimit(10, 60_000))
  linkStripeIntent(
    @Param('token') token: string,
    @Headers('idempotency-key') key: string | undefined,
  ) {
    return this.payments.linkStripeIntent(token, key);
  }

  @Post('payment-links/:token/culqi-charge')
  @Throttle(rateLimit(10, 60_000))
  linkCulqiCharge(
    @Param('token') token: string,
    @Headers('idempotency-key') key: string | undefined,
    @Body() dto: LinkCulqiChargeDto,
  ) {
    return this.payments.linkCulqiCharge(token, dto, key);
  }
}
