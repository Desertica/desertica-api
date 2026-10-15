import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EnvVars } from '../../config/env.validation';
import { BILLING_CLIENT } from './billing-client';
import { DOCUMENT_STORAGE, LocalDocumentStorage } from './document-storage';
import { ExchangeRateService } from './exchange-rate.service';
import { FakeBillingClient } from './fake-billing.client';
import { HttpBillingClient } from './http-billing.client';

@Global()
@Module({
  providers: [
    {
      provide: BILLING_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService<EnvVars, true>) =>
        config.get('BILLING_MODE', { infer: true }) === 'fake'
          ? new FakeBillingClient()
          : new HttpBillingClient({
              baseUrl: config.get('BILLING_URL', { infer: true }),
              serviceToken: config.get('BILLING_SERVICE_TOKEN', {
                infer: true,
              }),
            }),
    },
    {
      provide: DOCUMENT_STORAGE,
      inject: [ConfigService],
      useFactory: (config: ConfigService<EnvVars, true>) =>
        new LocalDocumentStorage(
          config.get('DOCUMENT_STORAGE_DIR', { infer: true }),
        ),
    },
    ExchangeRateService,
  ],
  exports: [BILLING_CLIENT, DOCUMENT_STORAGE, ExchangeRateService],
})
export class BillingModule {}
