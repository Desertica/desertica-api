-- Los 4 roles fijos (src/modules/roles/system-roles.ts; una prueba compara esta lista con el código).
-- "operator" conserva su clave y pasa a ser "Operaciones": sus usuarios no cambian de rol, pero pierden
-- reembolsos, emisión de comprobantes y reportes, que pasan a "finance".
INSERT INTO "Role" ("id", "key", "name", "permissions", "createdAt", "updatedAt") VALUES
  (gen_random_uuid(), 'admin', 'Administrador', '{"audit:read","bookings:cancel","bookings:override","bookings:read","bookings:write","catalog:read","catalog:write","company:read","company:write","complaints:read","complaints:write","customers:erase","customers:read","customers:write","departures:cancel","departures:read","departures:write","documents:issue","documents:read","documents:void","fraud:read","fraud:write","legal:write","payments:read","payments:refund","payments:refund-any","payments:write","prices:read","prices:write","reports:read","settings:read","settings:write","users:read","users:write","waivers:read"}', NOW(), NOW()),
  (gen_random_uuid(), 'operator', 'Operaciones', '{"bookings:read","bookings:write","bookings:cancel","departures:read","departures:write","catalog:read","prices:read","customers:read","customers:write","payments:read","payments:write","documents:read","complaints:read","complaints:write","waivers:read"}', NOW(), NOW()),
  (gen_random_uuid(), 'finance', 'Finanzas', '{"bookings:read","departures:read","catalog:read","prices:read","customers:read","payments:read","payments:write","payments:refund","documents:read","documents:issue","documents:void","reports:read","company:read","settings:read","complaints:read","audit:read"}', NOW(), NOW()),
  (gen_random_uuid(), 'readonly', 'Solo lectura', '{"bookings:read","departures:read","catalog:read","prices:read","payments:read","documents:read","reports:read","company:read","settings:read"}', NOW(), NOW())
ON CONFLICT ("key") DO UPDATE SET
  "name" = EXCLUDED."name",
  "permissions" = EXCLUDED."permissions",
  "updatedAt" = NOW();
