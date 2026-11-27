import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import {
  ADMIN_PERMISSIONS,
  ALL_PERMISSIONS,
  FINANCE_PERMISSIONS,
  OPERATOR_PERMISSIONS,
  READONLY_PERMISSIONS,
  RECENT_LOGIN_PERMISSIONS,
} from './permissions';
import { SYSTEM_ROLES } from '../roles/system-roles';

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

  it('keeps operations away from users, company, settings, refunds, issuing and reports', () => {
    for (const permission of OPERATOR_PERMISSIONS) {
      expect(permission).not.toMatch(/^(users|company|settings|reports):/);
      expect(permission).not.toMatch(/^payments:refund/);
      expect(permission).not.toMatch(/^documents:(issue|void)$/);
      expect(permission).not.toBe('bookings:override');
    }
    expect(OPERATOR_PERMISSIONS).toEqual(
      expect.arrayContaining([
        'bookings:write',
        'payments:write',
        'waivers:read',
        'complaints:write',
        'customers:write',
        'departures:write',
      ]),
    );
  });

  it('lets finance refund up to the cap, issue and void, but not manage users or see waivers', () => {
    expect(FINANCE_PERMISSIONS).toEqual(
      expect.arrayContaining([
        'payments:refund',
        'documents:issue',
        'documents:void',
        'reports:read',
        'audit:read',
      ]),
    );
    expect(FINANCE_PERMISSIONS).not.toContain('payments:refund-any');
    expect(FINANCE_PERMISSIONS).not.toContain('waivers:read');
    expect(
      FINANCE_PERMISSIONS.filter(
        (p) => /:(write)$/.test(p) && p !== 'payments:write',
      ),
    ).toEqual([]);
  });

  it('gives read-only only reads and no personal data', () => {
    for (const permission of READONLY_PERMISSIONS) {
      expect(permission).toMatch(/:read$/);
      expect(permission).not.toMatch(
        /^(customers|waivers|complaints|audit|users|fraud):/,
      );
    }
  });

  it('defines exactly the four fixed roles, with only known permissions', () => {
    expect(SYSTEM_ROLES.map((r) => r.key)).toEqual([
      'admin',
      'operator',
      'finance',
      'readonly',
    ]);
    for (const role of SYSTEM_ROLES) {
      for (const p of role.permissions) expect(ALL_PERMISSIONS).toContain(p);
      expect(new Set(role.permissions).size).toBe(role.permissions.length);
    }
  });

  it('asks for a recent login only on permissions the contract uses', () => {
    for (const p of RECENT_LOGIN_PERMISSIONS) expect(declared).toContain(p);
  });

  it('keeps the role migration in sync with the code', () => {
    const sql = readFileSync(
      join(
        __dirname,
        '../../../prisma/migrations/20261117120100_four_roles/migration.sql',
      ),
      'utf8',
    );
    for (const role of SYSTEM_ROLES) {
      const row = sql
        .split('\n')
        .find((line) => line.includes(`'${role.key}'`));
      expect(row).toBeDefined();
      const listed = [...row!.matchAll(/"([a-z]+:[a-z-]+)"/g)].map((m) => m[1]);
      expect(listed.sort()).toEqual([...role.permissions].sort());
    }
  });

  it('has no duplicates', () => {
    expect(new Set(ALL_PERMISSIONS).size).toBe(ALL_PERMISSIONS.length);
  });
});
