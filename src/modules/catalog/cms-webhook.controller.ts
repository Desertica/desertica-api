import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Post,
  Req,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import { rateLimit } from '../../common/throttle';
import { EnvVars } from '../../config/env.validation';
import { Prisma } from '../../generated/prisma/client';
import { Public } from '../auth/decorators';
import { TourRefsService } from './tour-refs.service';

const TOUR_EVENTS = [
  'entry.publish',
  'entry.unpublish',
  'entry.update',
  'entry.delete',
];

const digest = (value: string) => createHash('sha256').update(value).digest();

/**
 * Webhook de Strapi: al publicar o despublicar un tour, sincroniza solo ese tour.
 * Strapi no firma el cuerpo; autentica una cabecera secreta fija (ver `docs/WEBHOOKS.md` del CMS).
 */
@Public()
@Controller('webhooks')
export class CmsWebhookController {
  constructor(
    private readonly tourRefs: TourRefsService,
    private readonly config: ConfigService<EnvVars, true>,
  ) {}

  @Post('cms')
  @HttpCode(200)
  @Throttle(rateLimit(30, 60_000))
  async receive(
    @Headers('x-webhook-secret') secret: string | undefined,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    const expected = this.config.get('CMS_WEBHOOK_SECRET', { infer: true });
    if (!expected) {
      throw new ServiceUnavailableException('Webhook is not configured');
    }
    // Comparar hashes de igual largo: tiempo constante sin filtrar la longitud del secreto.
    if (!secret || !timingSafeEqual(digest(secret), digest(expected))) {
      throw new UnauthorizedException('Invalid webhook secret');
    }
    const { event, model, entry } = (body ?? {}) as {
      event?: unknown;
      model?: unknown;
      entry?: { slug?: unknown };
    };
    const slug = entry?.slug;
    if (
      model !== 'tour' ||
      !TOUR_EVENTS.includes(event as string) ||
      typeof slug !== 'string' ||
      !slug
    ) {
      return { ignored: true };
    }
    try {
      return await this.tourRefs.sync(null, req.ip, slug);
    } catch (error) {
      // Strapi manda un aviso por idioma a la vez: si dos crean el mismo tour, el segundo actualiza.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        return this.tourRefs.sync(null, req.ip, slug);
      }
      throw error;
    }
  }
}
