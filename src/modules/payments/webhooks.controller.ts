import {
  BadRequestException,
  Controller,
  HttpCode,
  Post,
  Req,
  ServiceUnavailableException,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request } from 'express';
import { Public } from '../auth/decorators';
import { PaymentEventsService } from './payment-events.service';
import {
  GatewayNotConfiguredError,
  InvalidWebhookSignatureError,
} from './providers/payment-gateway';
import { rawBodyOf } from './raw-body';

/**
 * Webhooks de las pasarelas. La firma se valida sobre el cuerpo crudo; sin
 * firma válida es 400 y no se guarda nada. Un evento repetido responde 200.
 */
@Public()
@SkipThrottle()
@Controller('webhooks')
export class WebhooksController {
  constructor(private readonly events: PaymentEventsService) {}

  @Post('stripe')
  @HttpCode(200)
  stripe(@Req() req: Request) {
    return this.receive('STRIPE', req);
  }

  @Post('culqi')
  @HttpCode(200)
  culqi(@Req() req: Request) {
    return this.receive('CULQI', req);
  }

  private async receive(provider: 'STRIPE' | 'CULQI', req: Request) {
    const raw = rawBodyOf(req);
    if (!raw) throw new BadRequestException('Expected a JSON body');
    try {
      await this.events.receive(provider, raw, req.headers);
    } catch (error) {
      if (error instanceof InvalidWebhookSignatureError) {
        throw new BadRequestException('Invalid webhook signature');
      }
      if (error instanceof GatewayNotConfiguredError) {
        throw new ServiceUnavailableException('Webhook is not configured');
      }
      throw error;
    }
    return { received: true };
  }
}
