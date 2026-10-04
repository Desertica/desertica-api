import type { Request, Response } from 'express';

export const REFRESH_COOKIE = 'desertica_refresh';
/** La cookie solo viaja a los endpoints de auth (el SPA nunca la lee). */
export const REFRESH_COOKIE_PATH = '/api/auth';

/** Lee una cookie del encabezado `Cookie` sin depender de `cookie-parser`. */
export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() !== name) continue;
    const raw = part.slice(index + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function setRefreshCookie(
  res: Response,
  token: string,
  maxAgeSeconds: number,
  secure: boolean,
): void {
  res.cookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    secure,
    sameSite: 'strict',
    path: REFRESH_COOKIE_PATH,
    maxAge: maxAgeSeconds * 1000,
  });
}

/** Emite la cookie vacía y vencida (`Max-Age=0`). */
export function clearRefreshCookie(res: Response, secure: boolean): void {
  res.cookie(REFRESH_COOKIE, '', {
    httpOnly: true,
    secure,
    sameSite: 'strict',
    path: REFRESH_COOKIE_PATH,
    maxAge: 0,
  });
}
