import {
  ArgumentsHost,
  Catch,
  ConflictException,
  ExceptionFilter,
  HttpException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import {
  AllExceptionsFilter,
  DatabaseBusyException,
} from './all-exceptions.filter';

/** Traduce errores conocidos de Prisma a HTTP y delega el formato. */
@Catch(Prisma.PrismaClientKnownRequestError)
export class PrismaExceptionFilter implements ExceptionFilter {
  private readonly delegate = new AllExceptionsFilter();

  catch(exception: Prisma.PrismaClientKnownRequestError, host: ArgumentsHost) {
    this.delegate.catch(this.toHttpException(exception), host);
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
    // P2024: pool agotado; P2028: transacción vencida o cerrada; P2034: conflicto de escritura o abrazo mortal.
    if (['P2024', 'P2028', 'P2034'].includes(exception.code)) {
      return new DatabaseBusyException();
    }
    return new InternalServerErrorException('Database request failed');
  }
}
