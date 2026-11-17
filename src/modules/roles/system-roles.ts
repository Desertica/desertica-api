import {
  ADMIN_PERMISSIONS,
  FINANCE_PERMISSIONS,
  OPERATOR_PERMISSIONS,
  READONLY_PERMISSIONS,
} from '../auth/permissions';

/**
 * Los 4 roles fijos. `operator` conserva su clave (usuarios existentes) y es
 * "Operaciones". La migración `20261117120100_four_roles` deja la base igual.
 */
export const SYSTEM_ROLES = [
  { key: 'admin', name: 'Administrador', permissions: ADMIN_PERMISSIONS },
  { key: 'operator', name: 'Operaciones', permissions: OPERATOR_PERMISSIONS },
  { key: 'finance', name: 'Finanzas', permissions: FINANCE_PERMISSIONS },
  { key: 'readonly', name: 'Solo lectura', permissions: READONLY_PERMISSIONS },
] as const;

interface RoleDb {
  role: {
    upsert(args: {
      where: { key: string };
      update: { name: string; permissions: string[] };
      create: { key: string; name: string; permissions: string[] };
    }): Promise<unknown>;
  };
}

/** Crea o actualiza los roles fijos. Lo usan el seed y las pruebas. */
export async function ensureSystemRoles(db: RoleDb): Promise<void> {
  for (const role of SYSTEM_ROLES) {
    const permissions = [...role.permissions];
    await db.role.upsert({
      where: { key: role.key },
      update: { name: role.name, permissions },
      create: { key: role.key, name: role.name, permissions },
    });
  }
}
