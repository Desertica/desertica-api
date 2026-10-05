import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EnvVars } from '../../config/env.validation';
import { CulqiGateway } from './providers/culqi.gateway';
import { FakeGateway } from './providers/fake.gateway';
import type { PaymentGateway } from './providers/payment-gateway';
import { StripeGateway } from './providers/stripe.gateway';

export type GatewayName = PaymentGateway['provider'];

/** Pasarelas por nombre. `PAYMENT_GATEWAY_MODE=fake` usa las simuladas. */
@Injectable()
export class GatewayRegistry {
  private readonly gateways: Record<GatewayName, PaymentGateway>;

  constructor(config: ConfigService<EnvVars, true>) {
    const get = <K extends keyof EnvVars>(key: K) =>
      config.get(key, { infer: true });
    this.gateways =
      get('PAYMENT_GATEWAY_MODE') === 'fake'
        ? { STRIPE: new FakeGateway('STRIPE'), CULQI: new FakeGateway('CULQI') }
        : {
            STRIPE: new StripeGateway({
              secretKey: get('STRIPE_SECRET_KEY'),
              publishableKey: get('STRIPE_PUBLISHABLE_KEY'),
              webhookSecret: get('STRIPE_WEBHOOK_SECRET'),
            }),
            CULQI: new CulqiGateway({
              secretKey: get('CULQI_SECRET_KEY'),
              publicKey: get('CULQI_PUBLIC_KEY'),
              apiUrl: get('CULQI_API_URL'),
              webhookSecret: get('CULQI_WEBHOOK_SECRET'),
            }),
          };
  }

  get(provider: GatewayName): PaymentGateway {
    return this.gateways[provider];
  }
}
