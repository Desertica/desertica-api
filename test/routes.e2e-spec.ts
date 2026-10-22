import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import {
  DiscoveryService,
  MetadataScanner,
  ModulesContainer,
  Reflector,
} from '@nestjs/core';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { IS_PUBLIC_KEY, PERMISSIONS_KEY } from '../src/modules/auth/decorators';
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

/**
 * Revisión de autorización: cada ruta implementada declara en el código lo
 * mismo que el contrato. Una operación nueva sin `@RequirePermission` (o con
 * otro permiso que `x-permission`) o una ruta pública que el contrato da por
 * protegida hacen fallar esta prueba.
 */
it('every route is public or guarded exactly as the contract says', async () => {
  const app = await createTestApp();
  const discovery = new DiscoveryService(app.get(ModulesContainer));
  const scanner = new MetadataScanner();
  const reflector = new Reflector();
  const METHODS = ['get', 'post', 'put', 'patch', 'delete'];
  const methodName = (n: number) =>
    ({ 0: 'get', 1: 'post', 2: 'put', 3: 'delete', 4: 'patch' })[n] ?? 'other';

  const spec = parse(
    readFileSync(join(__dirname, '../openapi/openapi.yaml'), 'utf8'),
  );
  const norm = (p: string) =>
    p
      .replace(/\/+/g, '/')
      .replace(/\/$/, '')
      .replace(/\{[^}]+\}/g, '{}')
      .replace(/:\w+/g, '{}');
  const contract = new Map<
    string,
    { permission?: string; isPublic: boolean }
  >();
  for (const [path, item] of Object.entries<any>(spec.paths)) {
    for (const [method, op] of Object.entries<any>(item)) {
      if (!METHODS.includes(method)) continue;
      contract.set(`${method} ${norm(path)}`, {
        permission: op['x-permission'],
        // Sin sesión del staff: `security: []` o solo otro esquema (cookie de refresh, token de reserva).
        isPublic: !(op.security ?? spec.security ?? []).some(
          (requirement: Record<string, unknown>) => 'bearerAuth' in requirement,
        ),
      });
    }
  }

  const problems: string[] = [];
  let checked = 0;
  for (const wrapper of discovery.getControllers()) {
    const { instance, metatype } = wrapper;
    if (!instance || !metatype) continue;
    const base = Reflect.getMetadata(PATH_METADATA, metatype) ?? '';
    for (const name of scanner.getAllMethodNames(
      Object.getPrototypeOf(instance),
    )) {
      const handler = instance[name];
      const path = Reflect.getMetadata(PATH_METADATA, handler);
      if (path === undefined) continue;
      const method = methodName(Reflect.getMetadata(METHOD_METADATA, handler));
      const key = `${method} ${norm(`/${base}/${path}`)}`;
      const documented = contract.get(key);
      if (!documented) continue; // lo cubre la prueba "toda ruta está en el contrato"
      checked++;
      const targets = [handler, metatype];
      const isPublic = !!reflector.getAllAndOverride<boolean>(
        IS_PUBLIC_KEY,
        targets,
      );
      const permissions =
        reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY, targets) ?? [];
      if (isPublic !== documented.isPublic && !key.endsWith('/health')) {
        problems.push(
          `${key}: público=${isPublic} pero el contrato dice ${documented.isPublic}`,
        );
      }
      if (isPublic) {
        if (permissions.length > 0)
          problems.push(`${key}: pública y con permisos`);
        continue;
      }
      const expected = documented.permission ? [documented.permission] : [];
      if (JSON.stringify(permissions) !== JSON.stringify(expected)) {
        problems.push(
          `${key}: permisos [${permissions.join(',')}] y el contrato dice [${expected.join(',')}]`,
        );
      }
    }
  }
  expect(checked).toBeGreaterThan(60);
  expect(problems).toEqual([]);
  await app.close();
});
