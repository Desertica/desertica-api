import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EnvVars } from '../../config/env.validation';
import { LogMailer } from './log-mailer';
import { MAILER, type Mailer } from './mailer';
import { NotificationsService } from './notifications.service';
import { SmtpMailer } from './smtp-mailer';

@Global()
@Module({
  providers: [
    {
      provide: MAILER,
      inject: [ConfigService],
      useFactory: (config: ConfigService<EnvVars, true>): Mailer =>
        config.get('MAIL_DRIVER', { infer: true }) === 'smtp'
          ? new SmtpMailer({
              host: config.get('SMTP_HOST', { infer: true }),
              port: config.get('SMTP_PORT', { infer: true }),
              secure: config.get('SMTP_SECURE', { infer: true }),
              requireTls: config.get('SMTP_REQUIRE_TLS', { infer: true }),
              user: config.get('SMTP_USER', { infer: true }) || undefined,
              password:
                config.get('SMTP_PASSWORD', { infer: true }) || undefined,
              from: config.get('MAIL_FROM', { infer: true }),
              replyTo:
                config.get('MAIL_REPLY_TO', { infer: true }) || undefined,
            })
          : new LogMailer(),
    },
    NotificationsService,
  ],
  exports: [MAILER, NotificationsService],
})
export class NotificationsModule {}
