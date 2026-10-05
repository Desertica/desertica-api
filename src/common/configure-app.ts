import {
  INestApplication,
  Logger,
  UnprocessableEntityException,
  ValidationError,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import helmet from 'helmet';
import { EnvVars } from '../config/env.validation';
import { captureWebhookRawBody } from '../modules/payments/raw-body';
import { AllExceptionsFilter } from './filters/all-exceptions.filter';
import { PrismaExceptionFilter } from './filters/prisma-exception.filter';
import { requestContext } from './request-context';

export function parseOrigins(raw: string): string[] {
  return raw
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function flatten(errors: ValidationError[], parent = ''): string[] {
  return errors.flatMap((error) => {
    const path = parent ? `${parent}.${error.property}` : error.property;
    const own = Object.values(error.constraints ?? {}).map(
      (message) => `${path}: ${message}`,
    );
    return [...own, ...flatten(error.children ?? [], path)];
  });
}

/** Configuración HTTP compartida por `main.ts` y las pruebas e2e. */
export function configureApp(app: INestApplication): void {
  const config = app.get<ConfigService<EnvVars, true>>(ConfigService);

  const http = app.getHttpAdapter().getInstance() as {
    set: (key: string, value: unknown) => void;
    disable: (key: string) => void;
  };
  // Cuántos saltos de proxy se confían para leer la IP real (`req.ip`) de `X-Forwarded-For`; Express
  // cuenta desde el final de la lista, así que lo que el cliente antepone no cuenta como IP.
  const trustProxy = config.get('TRUST_PROXY', { infer: true });
  http.set('trust proxy', trustProxy);
  if (config.get('NODE_ENV', { infer: true }) === 'production') {
    if (trustProxy === 0) {
      new Logger('configureApp').warn(
        'TRUST_PROXY=0 in production: every visitor will share the proxy address and the per-IP limits will not work. Set the number of proxy hops (2 behind Cloudflare and Coolify).',
      );
    }
  }
  http.disable('x-powered-by');

  app.use(helmet());
  app.use(requestContext);
  captureWebhookRawBody(app);
  app.enableCors({
    // Credenciales (cookie del refresh) solo para la lista explícita; nunca `*`.
    origin: parseOrigins(config.get('CORS_ORIGINS', { infer: true })),
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Accept-Language',
      'Authorization',
      'Content-Type',
      'Idempotency-Key',
      'X-Booking-Token',
      'X-Request-Id',
    ],
    exposedHeaders: ['X-Request-Id', 'RateLimit-Limit', 'Retry-After'],
    maxAge: 600,
  });

  app.useGlobalFilters(new AllExceptionsFilter(), new PrismaExceptionFilter());
  app.setGlobalPrefix('api');
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
      exceptionFactory: (errors) =>
        new UnprocessableEntityException(flatten(errors)),
    }),
  );
}
