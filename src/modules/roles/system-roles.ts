import { ADMIN_PERMISSIONS, OPERATOR_PERMISSIONS } from '../auth/permissions';

export const SYSTEM_ROLES = [
  { key: 'admin', name: 'Administrador', permissions: ADMIN_PERMISSIONS },
  { key: 'operator', name: 'Operador', permissions: OPERATOR_PERMISSIONS },
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

/** Crea o actualiza `admin` y `operator`. Lo usan el seed y las pruebas. */
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
