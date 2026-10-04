import { Module } from '@nestjs/common';
import { BookingsModule } from '../bookings/bookings.module';
import { CatalogModule } from '../catalog/catalog.module';
import { DisputesService } from './disputes.service';
import { EvidenceService } from './evidence.service';
import { GatewayRegistry } from './gateway.registry';
import { PaymentEventsService } from './payment-events.service';
import { PaymentsAdminController } from './payments-admin.controller';
import { PaymentsAdminService } from './payments-admin.service';
import { PublicPaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { RefundSweeper } from './refund-sweeper.service';
import { RefundsService } from './refunds-admin.service';
import { RefundsExecutor } from './refunds.service';
import { StaffAlertsService } from './staff-alerts.service';
import { WebhooksController } from './webhooks.controller';

@Module({
  imports: [BookingsModule, CatalogModule],
  controllers: [
    PublicPaymentsController,
    PaymentsAdminController,
    WebhooksController,
  ],
  providers: [
    DisputesService,
    EvidenceService,
    GatewayRegistry,
    PaymentsAdminService,
    PaymentsService,
    PaymentEventsService,
    RefundSweeper,
    RefundsExecutor,
    RefundsService,
    StaffAlertsService,
  ],
  exports: [
    GatewayRegistry,
    PaymentEventsService,
    RefundsExecutor,
    RefundsService,
    RefundSweeper,
  ],
})
export class PaymentsModule {}
