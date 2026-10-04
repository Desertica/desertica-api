import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import {
  ADMIN_PERMISSIONS,
  ALL_PERMISSIONS,
  OPERATOR_PERMISSIONS,
} from './permissions';

interface OpenApi {
  paths: Record<string, Record<string, { 'x-permission'?: string }>>;
}

const spec = parse(
  readFileSync(join(__dirname, '../../../openapi/openapi.yaml'), 'utf8'),
) as OpenApi;

const declared = new Set<string>();
for (const item of Object.values(spec.paths)) {
  for (const operation of Object.values(item)) {
    if (
      operation &&
      typeof operation === 'object' &&
      operation['x-permission']
    ) {
      declared.add(operation['x-permission']);
    }
  }
}

describe('permission catalog', () => {
  it('includes every x-permission declared in the OpenAPI contract', () => {
    const missing = [...declared].filter(
      (p) => !(ALL_PERMISSIONS as readonly string[]).includes(p),
    );
    expect(missing).toEqual([]);
  });

  it('has no permission that the contract never uses, apart from the documented extras', () => {
    const extras = ALL_PERMISSIONS.filter((p) => !declared.has(p));
    expect(extras.sort()).toEqual(['bookings:override', 'payments:refund-any']);
  });

  it('gives admin everything', () => {
    expect([...ADMIN_PERMISSIONS].sort()).toEqual([...ALL_PERMISSIONS].sort());
  });

  it('keeps operator away from users, company, settings and voiding', () => {
    for (const permission of OPERATOR_PERMISSIONS) {
      expect(permission).not.toMatch(/^(users|company|settings):/);
      expect(permission).not.toBe('documents:void');
      expect(permission).not.toBe('payments:refund-any');
      expect(permission).not.toBe('bookings:override');
    }
    expect(OPERATOR_PERMISSIONS).toEqual(
      expect.arrayContaining([
        'bookings:write',
        'payments:refund',
        'documents:issue',
        'complaints:write',
        'customers:write',
        'departures:write',
      ]),
    );
  });

  it('has no duplicates', () => {
    expect(new Set(ALL_PERMISSIONS).size).toBe(ALL_PERMISSIONS.length);
  });
});
