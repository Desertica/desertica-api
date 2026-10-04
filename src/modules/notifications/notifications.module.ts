import { Global, Module } from '@nestjs/common';
import { LogMailer } from './log-mailer';
import { MAILER } from './mailer';
import { NotificationsService } from './notifications.service';

@Global()
@Module({
  providers: [{ provide: MAILER, useClass: LogMailer }, NotificationsService],
  exports: [MAILER, NotificationsService],
})
export class NotificationsModule {}
