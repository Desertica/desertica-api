import { randomUUID } from 'node:crypto';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Params } from 'nestjs-pino';
import { redactUrl } from './sanitize';

/** Cabeceras y campos que nunca deben llegar a los logs. */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-booking-token"]',
  'req.headers["stripe-signature"]',
  'res.headers["set-cookie"]',
];

export function buildLoggerParams(options: {
  level: string;
  pretty: boolean;
}): Params {
  return {
    pinoHttp: {
      level: options.level,
      redact: { paths: REDACT_PATHS, censor: '[redacted]' },
      genReqId: (req: IncomingMessage, res: ServerResponse) => {
        const incoming = req.headers['x-request-id'];
        const id =
          typeof incoming === 'string' && /^[\w.-]{8,64}$/.test(incoming)
            ? incoming
            : randomUUID();
        res.setHeader('x-request-id', id);
        return id;
      },
      autoLogging: {
        ignore: (req: IncomingMessage) => req.url?.endsWith('/health') ?? false,
      },
      customLogLevel: (_req, res, err) => {
        if (err || res.statusCode >= 500) return 'error';
        if (res.statusCode >= 400) return 'warn';
        return 'info';
      },
      serializers: {
        req: (req: { id: string; method: string; url: string }) => ({
          id: req.id,
          method: req.method,
          url: redactUrl(req.url),
        }),
      },
      ...(options.pretty
        ? {
            transport: { target: 'pino-pretty', options: { singleLine: true } },
          }
        : {}),
    },
  };
}
