# Desértica API

API REST transaccional de Desértica: disponibilidad, reservas, pagos, comprobantes y operación. El contrato está en `openapi/openapi.yaml`.

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
npm run prisma:seed    # roles, admin inicial, política, tours y salidas de ejemplo
npm run start:dev
```

Sin Docker, instala PostgreSQL 16, crea el usuario/base `desertica` y usa la misma `DATABASE_URL` de `.env.example`.

Servicios locales:

| Recurso | URL |
| --- | --- |
| API | http://localhost:3000/api |
| Health | http://localhost:3000/api/health |
| Ready (Postgres y Redis si está configurado) | http://localhost:3000/api/health/ready |
| Swagger | http://localhost:3000/docs |

## Arquitectura

Cada capacidad vive en su módulo Nest. Prisma es infraestructura global. Un guard global exige sesión del staff en todo lo que no esté marcado `@Public()` y aplica `@RequirePermission('recurso:acción')` con las mismas cadenas que `x-permission` del contrato.

```text
src/
  main.ts, app.module.ts, common/configure-app.ts
  config/                 Esquema Joi de variables de entorno
  common/
    money/                Aritmética de dinero (IGV, depósito, reembolso, precios) con pruebas
    time/lima.ts          America/Lima: fechas locales, meses, días hábiles
    cache/                KeyValueStore (memoria o Redis) y almacén del rate limit
    idempotency/          Idempotency-Key (fila y efecto en la misma transacción)
    captcha/, pipes/, pagination/, filters/, logger/
  modules/
    auth/                 Login con Google, JWT, refresh con rotación, guard, permisos
    users/, roles/, audit/  Staff, roles (admin, operator) y auditoría de solo inserción
    settings/             Ajustes operativos (depósito, bloqueo, tope de reembolso, plazos)
    cms/                  Cliente de solo lectura del CMS con caché y último valor bueno
    catalog/              TourRef, salidas (con series), precios, bloqueos, políticas,
                          disponibilidad pública y cotización
    bookings/             Bloqueo de cupo, reservas web y manuales, pagos manuales, enlaces de
                          pago, cancelación, reprogramación, vencimientos
    customers/, compliance/, notifications/
test/                     e2e contra Postgres; cada respuesta se valida contra openapi.yaml
prisma/                   schema, migraciones (con triggers de solo inserción) y seed
```

Para agregar una capacidad: modelar en `prisma/schema.prisma`, **empezar por `openapi/openapi.yaml`**, crear el módulo, importarlo en `AppModule`.

### Cupos y concurrencia

Crear un bloqueo (`Hold`), una reserva manual o reprogramar toma `SELECT … FOR UPDATE` sobre la fila de la salida y cuenta vendidos y retenidos dentro de la misma transacción: dos peticiones sobre el último cupo se serializan y solo una gana (hay pruebas e2e con peticiones simultáneas). El orden de candados es siempre reserva → salidas (por id).

### Reservas web

`POST /public/holds` bloquea cupo `holdMinutes`; `POST /public/bookings` convierte el bloqueo en reserva `PENDING_PAYMENT`, guarda el snapshot de precio y de política, las aceptaciones legales y devuelve el token de "mi reserva" (solo se guarda su hash). El bloqueo pasa a ser la ventana de pago (`PAYMENT_WINDOW_MINUTES`); `ExpiryService` cancela las reservas web sin pago cuando vence, con un candado de Postgres para que varias instancias no barran a la vez. Lo que mueve dinero por pasarela (Stripe, Culqi, webhooks, reembolsos, comprobantes) es de la Ola 2: la cancelación solo calcula y deja `Refund` en `PENDING`.

### Correo

`Mailer` es una interfaz; el driver actual (`LogMailer`) escribe en el log. Los enlaces usan `PUBLIC_WEB_URL` y las rutas de `modules/bookings/links.ts` (`/booking/<ref>?token=`, `/waiver/<token>`, `/pay/<token>`).

### Pagos por pasarela

Todo lo que mueve dinero pasa por la interfaz `PaymentGateway` (`modules/payments/providers/payment-gateway.ts`) con tres adaptadores: `StripeGateway` (PaymentIntents con métodos automáticos para Apple Pay y Google Pay; solo USD), `CulqiGateway` (cargo con el token de Culqi.js; USD y PEN) y `FakeGateway` (`PAYMENT_GATEWAY_MODE=fake`, solo desarrollo y pruebas).

- **Flujo Stripe**: `createBookingStripeIntent` crea un `Payment` en `PENDING` y devuelve `clientSecret`; el navegador confirma con Stripe.js; **solo el webhook** (`/api/webhooks/stripe`) acredita el pago.
- **Flujo Culqi**: el navegador obtiene el token con Culqi.js y llama `createBookingCulqiCharge`; el API cobra. Si el banco pide 3DS, la respuesta trae `action: THREE_DS`: el navegador ejecuta Culqi3DS y reenvía el mismo token con `paymentId` y `authentication3DS`. El resultado servidor a servidor de Culqi y su webhook pasan por el mismo procesador (`PaymentEventsService`), idempotente por `WebhookEvent (provider, eventId)`.
- **Importe y moneda** salen siempre de la reserva o del enlace, nunca del cliente. Un evento con importe o moneda distintos al `Payment` se rechaza (`amount_mismatch`) y avisa al staff.
- **Pago tardío**: un pago confirmado sobre una reserva vencida por falta de pago (`payment_timeout`) la reactiva si la salida sigue abierta y hay cupo; si no, o si una persona la canceló, se crea un `Refund` automático y se avisa al staff. Un pago de más (dos cobros simultáneos) reembolsa el excedente.
- **Webhooks a registrar**: ver "Pasos manuales" del informe de la Ola 2. Las firmas se validan sobre el cuerpo crudo (`modules/payments/raw-body.ts`).

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

El modelo está documentado en la cabecera de `prisma/schema.prisma`. Las migraciones añaden a mano dos triggers (`AuditLog` y `LegalDocument` son de solo inserción); `prisma migrate dev` no los ve, así que no los borres al regenerar migraciones.

## Scripts

| Script | Qué hace |
| --- | --- |
| `npm run start:dev` | API en watch |
| `npm run build` | Compila a `dist/` |
| `npm test` | Unitarios |
| `npm run test:e2e` | Flujos reales contra PostgreSQL; valida cada respuesta contra `openapi/openapi.yaml` (`CONFORMANCE=off` lo desactiva) |
| `npm run openapi:lint` | Valida los contratos |
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

Ver `.env.example`. Se validan al arrancar con un esquema Joi (`src/config/env.validation.ts`): si falta una obligatoria o tiene un valor inválido, la API no inicia.

| Variable | Descripción |
| --- | --- |
| `DATABASE_URL` | Conexión PostgreSQL (obligatoria) |
| `REDIS_URL` | Opcional. Sin ella el rate limit y las cachés usan memoria (una sola instancia) |
| `CORS_ORIGINS` | Orígenes permitidos separados por coma (obligatoria en producción) |
| `TRUST_PROXY` | Saltos de proxy confiables para leer la IP real |
| `THROTTLE_LIMIT` / `THROTTLE_TTL_MS` | Rate limit global por IP |
| `LOG_LEVEL` | Nivel de log (pino, JSON en producción) |
| `JWT_ACCESS_SECRET`, `GOOGLE_CLIENT_ID`, `ALLOWED_EMAIL_DOMAIN` | Auth del staff |
| `CMS_URL`, `CMS_API_TOKEN`, `CMS_CACHE_TTL_SECONDS` | Cliente del CMS |

## Docker

```bash
docker compose up -d postgres            # Postgres
docker compose --profile redis up -d redis # Redis opcional
docker build -t desertica-api .
docker run --rm -p 3000:3000 --env-file .env desertica-api
```

CI corre lint, unitarios, e2e (con Postgres 16) y el build en `.github/workflows/ci.yml`.

## Cloud Agents

`scripts/cloud-install.sh` instala dependencias y genera Prisma. `scripts/cloud-start.sh` levanta PostgreSQL, aplica migraciones y deja la API en `:3000`.

## Pendiente de la Ola 2

Pasarelas (Stripe, Culqi) y webhooks, cliente de `desertica-billing`, Google Calendar y WhatsApp. El inventario de operaciones del contrato sin implementar sale con `SHOW_MISSING_OPERATIONS=1 npm run test:e2e -- test/routes`; el detalle está en `docs/PENDIENTES.md`.
