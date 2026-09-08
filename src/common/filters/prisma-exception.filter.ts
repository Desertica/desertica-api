import {
  ArgumentsHost,
  Catch,
  ConflictException,
  ExceptionFilter,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import { Response } from 'express';
import { Prisma } from '../../generated/prisma/client';

@Catch(Prisma.PrismaClientKnownRequestError)
export class PrismaExceptionFilter implements ExceptionFilter {
  catch(exception: Prisma.PrismaClientKnownRequestError, host: ArgumentsHost) {
    const httpException = this.toHttpException(exception);
    const response = host.switchToHttp().getResponse<Response>();
    const status = httpException.getStatus();

    response.status(status).json(httpException.getResponse());
  }

  private toHttpException(
    exception: Prisma.PrismaClientKnownRequestError,
  ): HttpException {
    if (exception.code === 'P2002') {
      const targetMeta = exception.meta?.target;
      const target = Array.isArray(targetMeta)
        ? targetMeta.join(', ')
        : typeof targetMeta === 'string'
          ? targetMeta
          : 'field';
      return new ConflictException(`Unique constraint failed on ${target}`);
    }

    if (exception.code === 'P2025') {
      return new NotFoundException('Record not found');
    }

    return new HttpException('Database request failed', 500);
  }
}
