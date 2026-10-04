import { Module } from '@nestjs/common';
import { BookingAccessService } from './booking-access.service';
import { BookingCreationService } from './booking-creation.service';
import { BookingLifecycleService } from './booking-lifecycle.service';
import { BookingPaymentsService } from './booking-payments.service';
import { BookingViewService } from './booking-view.service';
import { BookingsController } from './bookings.controller';
import { DepartureCancellationController } from './departure-cancellation.controller';
import { DepartureCancellationService } from './departure-cancellation.service';
import { ExpiryService } from './expiry.service';
import { HoldsService } from './holds.service';
import { PublicAccessService } from './public-access.service';
import { PublicBookingsController } from './public-bookings.controller';

@Module({
  controllers: [
    BookingsController,
    PublicBookingsController,
    DepartureCancellationController,
  ],
  providers: [
    BookingAccessService,
    BookingCreationService,
    BookingLifecycleService,
    BookingPaymentsService,
    BookingViewService,
    DepartureCancellationService,
    ExpiryService,
    HoldsService,
    PublicAccessService,
  ],
  exports: [BookingPaymentsService, BookingViewService, ExpiryService],
})
export class BookingsModule {}
