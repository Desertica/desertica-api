import {
  Injectable,
  Logger,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EnvVars } from '../../config/env.validation';

/**
 * Cloudflare Turnstile. Sin `TURNSTILE_SECRET_KEY` la verificación se omite
 * (desarrollo y pruebas); con la clave configurada el token es obligatorio.
 */
@Injectable()
export class CaptchaService {
  private readonly logger = new Logger(CaptchaService.name);

  constructor(private readonly config: ConfigService<EnvVars, true>) {}

  async verify(token: string | undefined, ip?: string): Promise<void> {
    const secret = this.config.get('TURNSTILE_SECRET_KEY', { infer: true });
    if (!secret) return;
    if (!token) throw new UnprocessableEntityException('Captcha required');
    try {
      const response = await fetch(
        'https://challenges.cloudflare.com/turnstile/v0/siteverify',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            secret,
            response: token,
            ...(ip ? { remoteip: ip } : {}),
          }),
          signal: AbortSignal.timeout(5000),
        },
      );
      const body = (await response.json()) as { success?: boolean };
      if (body.success === true) return;
    } catch (error) {
      this.logger.error(
        `Turnstile verification failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    throw new UnprocessableEntityException('Captcha verification failed');
  }
}
