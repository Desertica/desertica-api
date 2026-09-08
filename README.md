# Desértica API

API REST del catálogo de tours, reservas y pagos de Desértica.

Stack: **NestJS 11**, **Prisma 7** y **PostgreSQL 16**, con una arquitectura modular simple (un módulo por capacidad).

## Requisitos

- Node.js 22+
- npm 10+
- PostgreSQL 16 (Docker Compose o instalación nativa)
- Docker opcional, solo si usas `docker compose`

## Arranque rápido

```bash
cp .env.example .env
npm install
npm run db:up          # Postgres con Docker
npx prisma migrate dev # crea tablas y genera el cliente
npm run prisma:seed    # tours de ejemplo
npm run start:dev
```

Sin Docker, instala PostgreSQL 16, crea el usuario/base `desertica` y usa la misma `DATABASE_URL` de `.env.example`.

Servicios locales:

| Recurso | URL |
| --- | --- |
| API | http://localhost:3000/api |
| Health | http://localhost:3000/health |
| Ready (Postgres) | http://localhost:3000/health/ready |
| Swagger | http://localhost:3000/docs |

## Arquitectura

Cada capacidad de negocio vive en su propio módulo Nest. Prisma es infraestructura global; los módulos de dominio solo hablan con `PrismaService`.

```text
src/
  main.ts                 Arranque, Swagger, ValidationPipe
  app.module.ts           Composición de módulos
  common/                 Configuración HTTP compartida
  prisma/                 PrismaModule + PrismaService (adapter-pg)
  modules/
    health/               Liveness / readiness
    tours/                CRUD del catálogo (módulo de ejemplo)
prisma/
  schema.prisma           Modelos
  migrations/             SQL versionado
  seed.ts                 Datos de desarrollo
```

Para agregar una capacidad nueva (reservas, pagos, usuarios):

1. Modela en `prisma/schema.prisma` y corre `npm run prisma:migrate`.
2. Crea `src/modules/<nombre>/` con `module`, `controller`, `service` y DTOs.
3. Importa el módulo en `AppModule`.

`PrismaModule` es `@Global()`, así que no hace falta reimportarlo en cada feature.

## Prisma 7

El cliente se genera en `src/generated/prisma` (ignorado por git) con `moduleFormat = "cjs"` para alinearlo con NestJS. La URL de conexión vive en `prisma.config.ts`, no en el `datasource` del schema.

Comandos:

```bash
npm run prisma:generate
npm run prisma:migrate          # desarrollo
npm run prisma:migrate:deploy   # entornos ya creados
npm run prisma:studio
npm run prisma:seed
```

El modelo inicial es `Tour` (slug, título, precio en centavos, duración, publicación). Es la base del catálogo; reservas y pagos se suman como módulos aparte.

## Scripts

| Script | Qué hace |
| --- | --- |
| `npm run start:dev` | API en watch |
| `npm run build` | Compila a `dist/` |
| `npm test` | Unitarios (Prisma mockeado) |
| `npm run test:e2e` | Flujo real contra PostgreSQL |
| `npm run lint` | ESLint + Prettier |

## MCP (Cursor)

La configuración del proyecto está en `.cursor/mcp.json`. Tras abrir el repo en Cursor, habilita los servidores en **Settings → MCP**.

| Servidor | Uso |
| --- | --- |
| `prisma-local` | CLI de Prisma (`npx prisma mcp`) |
| `prisma-remote` | Consola Prisma (`https://mcp.prisma.io/mcp`, pide login) |
| `postgres` | Inspección/consultas SQL sobre la DB local |
| `context7` | Documentación actualizada de NestJS, Prisma y PostgreSQL |

`postgres` usa `POSTGRES_CONNECTION_STRING` con las credenciales **locales** de desarrollo (`desertica` / `desertica`). No apuntes este MCP a producción. `prisma-remote` y Context7 pueden pedir autenticación en el cliente.

Para forzar docs al día en el chat: *usa context7 para NestJS / Prisma / PostgreSQL*.

## Variables de entorno

Ver `.env.example`.

| Variable | Descripción |
| --- | --- |
| `DATABASE_URL` | Conexión PostgreSQL |
| `PORT` | Puerto HTTP (default `3000`) |
| `NODE_ENV` | `development` / `test` / `production` |

## Docker

```bash
docker compose up -d postgres
docker build -t desertica-api .
docker run --rm -p 3000:3000 --env-file .env desertica-api
```

CI corre lint, unitarios, e2e (con Postgres 16) y el build en `.github/workflows/ci.yml`.

## Cloud Agents

`scripts/cloud-install.sh` instala dependencias y genera Prisma. `scripts/cloud-start.sh` levanta PostgreSQL, aplica migraciones y deja la API en `:3000`.

## Qué no entra en este setup (siguiente iteración)

El esqueleto cubre Nest + Prisma + Postgres, un módulo de dominio (`tours`) y la infra de desarrollo. Aún no está, a propósito:

| Pieza | Por qué esperar |
| --- | --- |
| Auth (JWT / guards / roles) | Define usuarios y permisos antes de reservas y pagos |
| Módulos `bookings` y `payments` | Dependen del modelo de usuario y de un proveedor de pagos |
| Logger estructurado (Pino) y rate limit | Entra cuando haya tráfico real o un frontend |
| MCP de GitHub | Se conecta desde Cursor con el token de la cuenta; no hace falta en el repo |
