-- Login que abrió cada sesión: el refresh lo hereda y las acciones delicadas lo exigen reciente.
ALTER TABLE "RefreshToken" ADD COLUMN "authenticatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
-- Sesiones abiertas antes de este cambio: se toma la emisión del token como el login (no se puede saber mejor).
UPDATE "RefreshToken" SET "authenticatedAt" = "createdAt";
