import {
  INestApplication,
  UnprocessableEntityException,
  ValidationError,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import helmet from 'helmet';
import { EnvVars } from '../config/env.validation';
import { AllExceptionsFilter } from './filters/all-exceptions.filter';
import { PrismaExceptionFilter } from './filters/prisma-exception.filter';

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
  http.set('trust proxy', config.get('TRUST_PROXY', { infer: true }));
  http.disable('x-powered-by');

  app.use(helmet());
  app.enableCors({
    origin: parseOrigins(config.get('CORS_ORIGINS', { infer: true })),
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
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
