import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

/**
 * Conformidad con `openapi/openapi.yaml`: cada respuesta que reciben las
 * pruebas e2e (vía supertest) se valida contra el contrato.
 *
 * - La ruta y el método deben existir en el contrato.
 * - El estado debe estar documentado, salvo los de error transversales
 *   (400, 401, 403, 422, 429, 500, 503), que se validan contra `Error`.
 * - El cuerpo JSON debe cumplir el esquema de esa respuesta.
 */

type Json = Record<string, any>;

const spec = parse(
  readFileSync(join(__dirname, '../openapi/openapi.yaml'), 'utf8'),
) as Json;

const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema(spec, 'openapi', false);

/** Estados de error que no hace falta repetir en cada operación. */
export const IMPLICIT_ERROR_STATUSES = [400, 401, 403, 422, 429, 500, 503];

interface Operation {
  path: string;
  method: string;
  responses: Json;
  matcher: RegExp;
  params: number;
}

const operations: Operation[] = [];
for (const [path, item] of Object.entries<Json>(spec.paths)) {
  for (const [method, op] of Object.entries<Json>(item)) {
    if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;
    const params = (path.match(/\{[^}]+\}/g) ?? []).length;
    const matcher = new RegExp(
      '^' + path.replace(/\{[^}]+\}/g, '[^/]+').replace(/\//g, '\\/') + '$',
    );
    operations.push({ path, method, responses: op.responses, matcher, params });
  }
}

export function findOperation(method: string, url: string): Operation | null {
  const pathname = url.split('?')[0].replace(/^\/api(?=\/)/, '');
  return (
    operations
      .filter(
        (o) => o.method === method.toLowerCase() && o.matcher.test(pathname),
      )
      .sort((a, b) => a.params - b.params)[0] ?? null
  );
}

const deref = (node: Json | undefined): Json | undefined => {
  if (node?.$ref) {
    const pointer = String(node.$ref).replace(/^#\//, '').split('/');
    return pointer.reduce<any>(
      (acc, key) => acc?.[key.replace(/~1/g, '/')],
      spec,
    );
  }
  return node;
};

const validators = new Map<string, ReturnType<typeof ajv.compile> | null>();

function validatorFor(op: Operation, status: number) {
  const key = `${op.method} ${op.path} ${status}`;
  if (validators.has(key)) return validators.get(key)!;
  let response = deref(op.responses[String(status)]);
  if (!response && IMPLICIT_ERROR_STATUSES.includes(status)) {
    response = deref(spec.components.responses.Error);
  }
  const schema = response?.content?.['application/json']?.schema as
    Json | undefined;
  const compiled = schema
    ? ajv.compile(
        JSON.parse(
          JSON.stringify(schema).replace(/"\$ref":"#\//g, '"$ref":"openapi#/'),
        ),
      )
    : null;
  validators.set(key, compiled);
  return compiled;
}

export interface ResponseLike {
  status: number;
  body: unknown;
  headers: Record<string, string>;
  text?: string;
}

/** Devuelve la lista de incumplimientos (vacía si la respuesta es conforme). */
export function checkConformance(
  method: string,
  url: string,
  res: ResponseLike,
): string[] {
  // Los preflight CORS no forman parte del contrato.
  if (url.startsWith('/api/docs') || method.toUpperCase() === 'OPTIONS') {
    return [];
  }
  const op = findOperation(method, url);
  const label = `${method.toUpperCase()} ${url.split('?')[0]} -> ${res.status}`;
  if (!op) {
    // Una ruta que el router no conoce responde 404; cualquier otro estado es una ruta sin documentar.
    return res.status === 404
      ? []
      : [`${label}: la ruta no existe en openapi.yaml`];
  }

  const documented = deref(op.responses[String(res.status)]);
  if (!documented && !IMPLICIT_ERROR_STATUSES.includes(res.status)) {
    return [
      `${label}: estado no documentado para ${op.method.toUpperCase()} ${op.path}`,
    ];
  }
  const contentType = res.headers['content-type'] ?? '';
  // Una respuesta en otro tipo de medio documentado (p. ej. `text/csv`) no es JSON.
  const mediaType = contentType.split(';')[0].trim();
  if (
    mediaType &&
    mediaType !== 'application/json' &&
    documented?.content?.[mediaType]
  ) {
    return [];
  }
  const validate = validatorFor(op, res.status);
  if (!validate) {
    // Sin esquema JSON documentado (204, binarios, solo descripción).
    if (res.status === 204 && res.text) return [`${label}: 204 con cuerpo`];
    return [];
  }
  if (!contentType.includes('application/json')) {
    return [`${label}: se esperaba JSON y llegó "${contentType}"`];
  }
  if (validate(res.body)) return [];
  return (validate.errors ?? []).map(
    (e) =>
      `${label}: ${e.instancePath || '/'} ${e.message} ${JSON.stringify(e.params)}`,
  );
}
