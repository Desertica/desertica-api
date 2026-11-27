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
 * `operator` (Operaciones: guías y atención al cliente). Reservas, calendario,
 * clientes, pagos manuales cobrados en campo, reclamos y descargos (los guías
 * necesitan las notas médicas). Sin reembolsos, emisión de comprobantes ni
 * reportes de ventas: eso es de Finanzas.
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
  'documents:read',
  'complaints:read',
  'complaints:write',
  'waivers:read',
];

/**
 * `finance` (Finanzas: contabilidad y cobranzas). Reembolsa hasta el tope,
 * emite y anula comprobantes y lee la bitácora para revisar pagos manuales.
 */
export const FINANCE_PERMISSIONS: readonly Permission[] = [
  'bookings:read',
  'departures:read',
  'catalog:read',
  'prices:read',
  'customers:read',
  'payments:read',
  'payments:write',
  'payments:refund',
  'documents:read',
  'documents:issue',
  'documents:void',
  'reports:read',
  'company:read',
  'settings:read',
  'complaints:read',
  'audit:read',
];

/**
 * `readonly` (Solo lectura: socio, asesor o contador externo). Sin datos de
 * clientes, descargos ni reclamos.
 */
export const READONLY_PERMISSIONS: readonly Permission[] = [
  'bookings:read',
  'departures:read',
  'catalog:read',
  'prices:read',
  'payments:read',
  'documents:read',
  'reports:read',
  'company:read',
  'settings:read',
];

/**
 * Permisos de las acciones delicadas: la operación que exige alguno de ellos
 * pide además un login con Google reciente (`REAUTH_MAX_AGE_MINUTES`).
 */
export const RECENT_LOGIN_PERMISSIONS: ReadonlySet<Permission> = new Set([
  'payments:refund',
  'users:write',
  'settings:write',
  'company:write',
  'legal:write',
  'customers:erase',
  'departures:cancel',
]);
