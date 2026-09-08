import {
  INestApplication,
  RequestMethod,
  ValidationPipe,
} from '@nestjs/common';
import { PrismaExceptionFilter } from './filters/prisma-exception.filter';

export function configureApp(app: INestApplication): void {
  app.useGlobalFilters(new PrismaExceptionFilter());
  app.setGlobalPrefix('api', {
    exclude: [
      { path: 'health', method: RequestMethod.ALL },
      { path: 'health/{*path}', method: RequestMethod.ALL },
    ],
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  app.enableCors();
}
