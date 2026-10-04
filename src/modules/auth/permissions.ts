/**
 * Catálogo de permisos. Las cadenas son las mismas que `x-permission` en
 * `openapi/openapi.yaml` (una prueba lo verifica) más dos que el contrato
 * menciona en descripciones: `bookings:override` y `payments:refund-any`.
 */
export const ALL_PERMISSIONS = [
  'audit:read',
  'bookings:cancel',
  'bookings:override',
  'bookings:read',
  'bookings:write',
  'catalog:read',
  'catalog:write',
  'company:read',
  'company:write',
  'complaints:read',
  'complaints:write',
  'customers:erase',
  'customers:read',
  'customers:write',
  'departures:cancel',
  'departures:read',
  'departures:write',
  'documents:issue',
  'documents:read',
  'documents:void',
  'fraud:read',
  'fraud:write',
  'legal:write',
  'payments:read',
  'payments:refund',
  'payments:refund-any',
  'payments:write',
  'prices:read',
  'prices:write',
  'reports:read',
  'settings:read',
  'settings:write',
  'users:read',
  'users:write',
  'waivers:read',
] as const;

export type Permission = (typeof ALL_PERMISSIONS)[number];

/** `admin`: todo. */
export const ADMIN_PERMISSIONS: readonly Permission[] = ALL_PERMISSIONS;

/**
 * `operator`: reservas, calendario, clientes, pagos (reembolsos hasta un tope,
 * sin `refund-any`), comprobantes y reclamos. Sin `users:*`, `company:*`,
 * `settings:*` ni `documents:void`.
 */
export const OPERATOR_PERMISSIONS: readonly Permission[] = [
  'bookings:read',
  'bookings:write',
  'bookings:cancel',
  'departures:read',
  'departures:write',
  'catalog:read',
  'prices:read',
  'customers:read',
  'customers:write',
  'payments:read',
  'payments:write',
  'payments:refund',
  'documents:read',
  'documents:issue',
  'complaints:read',
  'complaints:write',
  'waivers:read',
  'reports:read',
];

export function isPermission(value: string): value is Permission {
  return (ALL_PERMISSIONS as readonly string[]).includes(value);
}
