import { AsyncLocalStorage } from 'node:async_hooks';
import type { NextFunction, Request, Response } from 'express';
import { AppLocale, pickLocale } from './locale';

interface RequestContext {
  locale: AppLocale;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** Idioma de la petición en curso (`Accept-Language`); inglés fuera de una petición. */
export const requestLocale = (): AppLocale =>
  storage.getStore()?.locale ?? 'en';

export function requestContext(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  storage.run({ locale: pickLocale(req.headers['accept-language']) }, next);
}
