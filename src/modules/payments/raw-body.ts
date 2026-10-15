import { json } from 'express';
import type { NextFunction, Request, Response } from 'express';
import type { INestApplication } from '@nestjs/common';

const RAW = Symbol('rawBody');

type WithRaw = Request & { [RAW]?: Buffer };

/**
 * Las firmas de webhook se calculan sobre los bytes exactos que mandó la
 * pasarela. Esto guarda esos bytes para `/api/webhooks/*` antes de que Nest
 * parsee el JSON (el parser global se salta una petición ya parseada).
 */
export function captureWebhookRawBody(app: INestApplication): void {
  const parse = json({
    limit: '1mb',
    verify: (req, _res, buf) => {
      (req as WithRaw)[RAW] = Buffer.from(buf);
    },
  });
  // Nest se salta su propio parser si ve un middleware llamado `jsonParser`
  // (el nombre de la función de body-parser): por eso se envuelve con otro nombre.
  app.use(
    '/api/webhooks',
    function webhookRawBody(req: Request, res: Response, next: NextFunction) {
      parse(req, res, next);
    },
  );
}

export const rawBodyOf = (req: Request): Buffer | undefined =>
  (req as WithRaw)[RAW];
