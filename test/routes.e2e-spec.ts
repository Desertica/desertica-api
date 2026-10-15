import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { createTestApp } from './helpers';

/**
 * Cobertura del contrato: lista las operaciones de openapi.yaml que todavía
 * no tienen ruta. No falla: sirve de inventario (ver docs/PENDIENTES.md) y
 * garantiza que ninguna ruta implementada quede fuera del contrato.
 */
it('every implemented route is in the contract; reports the missing operations', async () => {
  const app = await createTestApp();
  const server = app.getHttpAdapter().getInstance() as {
    router?: { stack: any[] };
    _router?: { stack: any[] };
  };
  const stack = server.router?.stack ?? server._router?.stack ?? [];
  const norm = (p: string) =>
    p.replace(/\{[^}]+\}/g, '{}').replace(/:\w+/g, '{}');
  const implemented = new Set<string>();
  for (const layer of stack) {
    if (
      !layer.route ||
      typeof layer.route.path !== 'string' ||
      layer.route.path.includes('*')
    )
      continue;
    for (const method of Object.keys(layer.route.methods as object)) {
      implemented.add(
        norm(`${method} ${String(layer.route.path).replace(/^\/api/, '')}`),
      );
    }
  }
  const spec = parse(
    readFileSync(join(__dirname, '../openapi/openapi.yaml'), 'utf8'),
  );
  const documented = new Set<string>();
  const missing: string[] = [];
  for (const [path, item] of Object.entries<any>(spec.paths)) {
    for (const [method, op] of Object.entries<any>(item)) {
      if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;
      documented.add(norm(`${method} ${path}`));
      if (!implemented.has(norm(`${method} ${path}`)))
        missing.push(`${op.operationId}`);
    }
  }
  const undocumented = [...implemented].filter(
    (r) => !documented.has(r) && !r.endsWith('/docs'),
  );
  if (process.env.SHOW_MISSING_OPERATIONS)
    console.log(
      `Sin implementar (${missing.length}/${documented.size}):\n${missing.join('\n')}`,
    );
  expect(undocumented).toEqual([]);
  await app.close();
});
