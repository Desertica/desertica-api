import { Global, Module } from '@nestjs/common';
import { StaffAlertsService } from './staff-alerts.service';

@Global()
@Module({
  providers: [StaffAlertsService],
  exports: [StaffAlertsService],
})
export class AlertsModule {}
