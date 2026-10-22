import { ArgumentsHost } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { AllExceptionsFilter } from './all-exceptions.filter';
import { PrismaExceptionFilter } from './prisma-exception.filter';

function run(
  filter: { catch(e: any, h: ArgumentsHost): void },
  error: unknown,
) {
  const res = {
    headersSent: false,
    headers: {} as Record<string, string>,
    code: 0,
    setHeader: (k: string, v: string) => {
      res.headers[k] = v;
    },
    status: (c: number) => {
      res.code = c;
      return res;
    },
    json: () => undefined,
  };
  const host = {
    switchToHttp: () => ({
      getResponse: () => res,
      getRequest: () => ({ method: 'GET', url: '/x' }),
    }),
  } as unknown as ArgumentsHost;
  filter.catch(error, host);
  return res;
}

describe('database overload', () => {
  it.each(['P2024', 'P2028', 'P2034'])(
    'answers 503 with Retry-After for Prisma %s',
    (code) => {
      const err = new Prisma.PrismaClientKnownRequestError('x', {
        code,
        clientVersion: 'test',
      });
      const res = run(new PrismaExceptionFilter(), err);
      expect(res.code).toBe(503);
      expect(res.headers['Retry-After']).toBe('1');
    },
  );

  it('answers 503 with Retry-After when the pg pool times out', () => {
    const res = run(
      new AllExceptionsFilter(),
      new Error('timeout exceeded when trying to connect'),
    );
    expect(res.code).toBe(503);
    expect(res.headers['Retry-After']).toBe('1');
  });

  it('keeps other errors as 500 without Retry-After', () => {
    const res = run(new AllExceptionsFilter(), new Error('boom'));
    expect(res.code).toBe(500);
    expect(res.headers['Retry-After']).toBeUndefined();
  });
});
