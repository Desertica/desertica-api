import Test from 'supertest/lib/test';
import { checkConformance } from './conformance';

/**
 * Toda petición hecha con supertest valida su respuesta contra el contrato
 * OpenAPI. Se desactiva con CONFORMANCE=off.
 */
if (process.env.CONFORMANCE !== 'off') {
  const original = Test.prototype.assert;
  Test.prototype.assert = function (resError, res, fn) {
    return original.call(
      this,
      resError,
      res,
      (err: Error | null, response: any) => {
        if (!err && response) {
          const problems = checkConformance(
            this.method,
            this.url.replace(/^https?:\/\/[^/]+/, ''),
            {
              status: response.status,
              body: response.body,
              headers: response.headers,
              text: response.text,
            },
          );
          if (problems.length > 0) {
            err = new Error(
              `Respuesta fuera de contrato:\n  ${problems.join('\n  ')}`,
            );
          }
        }
        fn?.call(this, err, response);
      },
    );
  };
}
