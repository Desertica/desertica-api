import { Module } from '@nestjs/common';
import { BookingsModule } from '../bookings/bookings.module';
import { CatalogModule } from '../catalog/catalog.module';
import { GatewayRegistry } from './gateway.registry';
import { PaymentEventsService } from './payment-events.service';
import { PublicPaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { RefundsExecutor } from './refunds.service';
import { StaffAlertsService } from './staff-alerts.service';
import { WebhooksController } from './webhooks.controller';

@Module({
  imports: [BookingsModule, CatalogModule],
  controllers: [PublicPaymentsController, WebhooksController],
  providers: [
    GatewayRegistry,
    PaymentsService,
    PaymentEventsService,
    RefundsExecutor,
    StaffAlertsService,
  ],
  exports: [GatewayRegistry, PaymentEventsService, RefundsExecutor],
})
export class PaymentsModule {}
