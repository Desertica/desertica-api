import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { STATUS_CODES } from 'node:http';
import { describeError, redactUrl } from '../logger/sanitize';

export interface ErrorBody {
  statusCode: number;
  error: string;
  message: string | string[];
  details?: Record<string, unknown>;
}

/**
 * Normaliza toda respuesta de error al formato del contrato:
 * `{ statusCode, error, message, details? }`.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const response = http.getResponse<Response>();
    const request = http.getRequest<Request>();

    const body = this.toBody(exception);
    if (body.statusCode >= 500) {
      this.logger.error(
        `${request.method} ${redactUrl(request.url)} -> ${body.statusCode}`,
        describeError(exception),
      );
    }
    if (response.headersSent) return;
    response.status(body.statusCode).json(body);
  }

  toBody(exception: unknown): ErrorBody {
    if (exception instanceof HttpException) {
      const statusCode = exception.getStatus();
      const raw = exception.getResponse();
      const error = STATUS_CODES[statusCode] ?? 'Error';
      if (typeof raw === 'string') {
        return { statusCode, error, message: raw };
      }
      const obj = raw as Record<string, unknown>;
      const message = obj.message ?? exception.message;
      const body: ErrorBody = {
        statusCode,
        error: typeof obj.error === 'string' ? obj.error : error,
        message: message as string | string[],
      };
      if (obj.details && typeof obj.details === 'object') {
        body.details = obj.details as Record<string, unknown>;
      }
      return body;
    }
    return {
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      error: STATUS_CODES[500]!,
      message: 'Internal server error',
    };
  }
}
