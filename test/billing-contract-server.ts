import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { parse } from 'yaml';
import {
  BillingError,
  type EmitRequest,
} from '../src/modules/billing/billing-client';
import { FakeBillingClient } from '../src/modules/billing/fake-billing.client';

type Json = Record<string, any>;

const spec = parse(
  readFileSync(join(__dirname, '../openapi/billing.yaml'), 'utf8'),
) as Json;

const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema(spec, 'billing', false);
const schema = (name: string) =>
  ajv.getSchema(`billing#/components/schemas/${name}`)!;

export interface ContractServer {
  url: string;
  token: string;
  fake: FakeBillingClient;
  /** Incumplimientos del contrato que vio el servidor (petición o respuesta inválidas). */
  violations: string[];
  /** Peticiones recibidas: método, ruta y cuerpo. */
  requests: { method: string; path: string; body?: unknown }[];
  close(): Promise<void>;
}

/**
 * Servidor HTTP que implementa `openapi/billing.yaml` sobre `FakeBillingClient`
 * y valida cada petición y cada respuesta contra el esquema del contrato: si el
 * cliente del API manda algo inválido, o este servidor responde algo que el
 * contrato no permite, queda en `violations`.
 */
export async function startBillingServer(
  fake = new FakeBillingClient(),
  token = 'service-token-test',
): Promise<ContractServer> {
  const violations: string[] = [];
  const requests: ContractServer['requests'] = [];

  const check = (name: string, value: unknown, label: string) => {
    const validate = schema(name);
    if (!validate(value)) {
      violations.push(
        `${label}: ${JSON.stringify(validate.errors?.map((e) => `${e.instancePath} ${e.message}`))}`,
      );
    }
  };

  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', () => {
      void handle(raw);
    });

    const send = (
      status: number,
      body: unknown,
      label?: string,
      name?: string,
    ) => {
      if (name && status === 200) check(name, body, `response ${label}`);
      res.statusCode = status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(body));
    };
    const fail = (error: unknown) => {
      if (error instanceof BillingError) {
        const body = {
          code: error.code,
          message: error.message,
          retryable: error.retryable,
        };
        check('Error', body, 'error response');
        return send(error.httpStatus, body);
      }
      return send(500, { code: 'INTERNAL_ERROR', message: String(error) });
    };

    async function handle(rawBody: string) {
      const path = (req.url ?? '').split('?')[0];
      let body: unknown;
      if (rawBody) {
        try {
          body = JSON.parse(rawBody);
        } catch {
          return send(400, { code: 'INVALID_JSON', message: 'bad json' });
        }
      }
      requests.push({ method: req.method ?? '', path, body });
      if (
        path !== '/health' &&
        req.headers.authorization !== `Bearer ${token}`
      ) {
        return send(401, { code: 'UNAUTHORIZED', message: 'bad token' });
      }
      try {
        if (req.method === 'POST' && path === '/v1/documents') {
          check('EmitDocumentRequest', body, 'request POST /v1/documents');
          return send(
            200,
            await fake.emit(body as EmitRequest),
            'emit',
            'EmitDocumentResult',
          );
        }
        let m = /^\/v1\/documents\/([^/]+)$/.exec(path);
        if (req.method === 'GET' && m) {
          const found = await fake.getStatus(m[1]);
          return found
            ? send(200, found, 'status', 'EmitDocumentResult')
            : send(404, { code: 'NOT_FOUND', message: 'unknown' });
        }
        m = /^\/v1\/documents\/([^/]+)\/files\/(xml|cdr|pdf)$/.exec(path);
        if (req.method === 'GET' && m) {
          const file = await fake.downloadFile(m[1], m[2] as 'xml');
          if (!file)
            return send(404, { code: 'NOT_FOUND', message: 'no file' });
          res.statusCode = 200;
          res.setHeader('content-type', file.contentType);
          return res.end(file.data);
        }
        m = /^\/v1\/documents\/([^/]+)\/void$/.exec(path);
        if (req.method === 'POST' && m) {
          const b = body as Json;
          if (!b?.reason || !b?.voidDate || String(b.reason).length > 100) {
            violations.push('request void: invalid body');
          }
          return send(
            200,
            await fake.void(m[1], b as any),
            'void',
            'TicketResult',
          );
        }
        m = /^\/v1\/tickets\/([^/]+)$/.exec(path);
        if (req.method === 'GET' && m) {
          const t = await fake.getTicket(m[1]);
          return t
            ? send(200, t, 'ticket', 'TicketResult')
            : send(404, { code: 'NOT_FOUND', message: 'unknown ticket' });
        }
        return send(404, { code: 'NOT_FOUND', message: 'no route' });
      } catch (error) {
        return fail(error);
      }
    }
  });

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    token,
    fake,
    violations,
    requests,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
