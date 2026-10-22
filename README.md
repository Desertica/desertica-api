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
    queue/                Cola en memoria para trabajo que no debe retrasar la respuesta
    web-links.ts          Enlaces a la web con prefijo de idioma (`/es/…`)
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
    admin/                Empresa y series, bloqueos de correos e IP, panel y reporte de ventas,
                          mensajes de contacto
    payments/             Pasarelas (Stripe, Culqi, simulada), webhooks, reembolsos, disputas
    billing/, documents/  Cliente de desertica-billing, comprobantes, cola y almacenamiento
    customers/, compliance/ Clientes, descargos, textos legales y reclamos
    notifications/, alerts/ Correo (plantillas, drivers) y avisos al staff
    health/               /health y /health/ready
test/                     e2e contra Postgres; cada respuesta se valida contra openapi.yaml
prisma/                   schema, migraciones (con triggers de solo inserción) y seed
```

Para agregar una capacidad: modelar en `prisma/schema.prisma`, **empezar por `openapi/openapi.yaml`**, crear el módulo, importarlo en `AppModule`.

### Cupos y concurrencia

Crear un bloqueo (`Hold`), una reserva manual o reprogramar toma `SELECT … FOR UPDATE` sobre la fila de la salida y cuenta vendidos y retenidos dentro de la misma transacción: dos peticiones sobre el último cupo se serializan y solo una gana (hay pruebas e2e con peticiones simultáneas). Cuando una operación toca una reserva existente (cancelar, reprogramar, eventos de pago, reembolsos) el orden es reserva → salidas (por id); convertir un bloqueo en reserva toma bloqueo → salida. `cancelDeparture` toma la salida y luego sus reservas, al revés que el resto (pendiente de unificar).

Dentro de una transacción solo se usa su `tx`: pedir otra conexión al pool desde ahí lo agota con unas pocas peticiones simultáneas. El pool se configura con `DB_POOL_MAX`, `DB_CONNECTION_TIMEOUT_MS`, `DB_STATEMENT_TIMEOUT_MS` y `DB_IDLE_IN_TX_TIMEOUT_MS`; si se agota o una transacción se aborta, la API responde 503 con `Retry-After`. Las llamadas a la pasarela no se hacen dentro de una transacción.

### Reservas web

`POST /public/holds` bloquea cupo `holdMinutes`; `POST /public/bookings` convierte el bloqueo en reserva `PENDING_PAYMENT`, guarda el snapshot de precio y de política, las aceptaciones legales y devuelve el token de "mi reserva" (solo se guarda su hash). El bloqueo pasa a ser la ventana de pago (`PAYMENT_WINDOW_MINUTES`); `ExpiryService` cancela las reservas web sin pago cuando vence, con un candado de Postgres para que varias instancias no barran a la vez. Los pagos, reembolsos y comprobantes se describen más abajo; la cancelación calcula el reembolso y deja un `Refund` en `PENDING` que ejecuta `RefundSweeper`.

### Correo

`Mailer` es una interfaz con dos drivers que se eligen con `MAIL_DRIVER`:

- `log` (por defecto fuera de producción): `LogMailer` escribe el correo, con sus enlaces y tokens, en el log. Solo para desarrollo y pruebas.
- `smtp` (obligatorio en producción): `SmtpMailer` (nodemailer) con `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_REQUIRE_TLS`, `SMTP_USER`/`SMTP_PASSWORD` (opcionales, van juntos) y `MAIL_FROM`. Sirve el relay de Google Workspace: `smtp-relay.gmail.com`, puerto 587 con STARTTLS, autorizando la IP del servidor en la consola de Workspace (o `smtp.gmail.com` con una contraseña de aplicación). Para probar en local, Mailpit en `localhost:1025` con `SMTP_REQUIRE_TLS=false`.

Las plantillas (`modules/notifications/templates/`) describen cada correo como bloques y de ahí salen el texto y el HTML, en español para `es*` y en inglés para el resto según el `locale` de la reserva; los avisos internos van siempre en español. Todo lo que viene de una persona se escapa. Para agregar una plantilla: una función en `booking.ts` o `compliance.ts`, registrarla en `index.ts` y añadir sus datos de ejemplo a `templates.spec.ts` (la prueba falla si falta). Los enlaces usan `PUBLIC_WEB_URL` y las rutas de `modules/bookings/links.ts` con el idioma de la reserva (`/<idioma>/booking/<ref>?token=`, `/<idioma>/waiver/<token>`, `/<idioma>/pay/<token>`).

### Descargos de responsabilidad

El texto vive en el CMS (`tour.waiverBody`). `POST /legal-documents` con `kind: WAIVER` y `tourRefId` guarda un snapshot inmutable por tour e idioma; cada `Waiver` apunta (`legalDocumentId`) a la versión vigente en el idioma de la reserva (o la de `en`) y el formulario público devuelve ese texto. Un tour que exige descargo y no tiene ninguno publicado no se puede reservar (409): publica el descargo de cada tour antes de venderlo.

### IP del cliente y trabajo en segundo plano

`req.ip` sale de `X-Forwarded-For` solo hasta `TRUST_PROXY` saltos contados desde el final (2 detrás de Cloudflare y Coolify); en producción `TRUST_PROXY` es obligatorio y la API no arranca sin él. "Mi reserva" responde igual de rápido exista o no la reserva porque la búsqueda y el envío van a `BackgroundQueue` (en memoria: un reinicio pierde lo pendiente, el cliente puede volver a pedir el enlace).

### Pagos por pasarela

Todo lo que mueve dinero pasa por la interfaz `PaymentGateway` (`modules/payments/providers/payment-gateway.ts`) con tres adaptadores: `StripeGateway` (PaymentIntents con métodos automáticos para Apple Pay y Google Pay; solo USD), `CulqiGateway` (cargo con el token de Culqi.js; USD y PEN) y `FakeGateway` (`PAYMENT_GATEWAY_MODE=fake`, solo desarrollo y pruebas).

- **Flujo Stripe**: `createBookingStripeIntent` crea un `Payment` en `PENDING` y devuelve `clientSecret`; el navegador confirma con Stripe.js; **solo el webhook** (`/api/webhooks/stripe`) acredita el pago.
- **Flujo Culqi**: el navegador obtiene el token con Culqi.js y llama `createBookingCulqiCharge`; el API cobra. Si el banco pide 3DS, la respuesta trae `action: THREE_DS`: el navegador ejecuta Culqi3DS y reenvía el mismo token con `paymentId` y `authentication3DS`. El resultado servidor a servidor de Culqi y su webhook pasan por el mismo procesador (`PaymentEventsService`), idempotente por `WebhookEvent (provider, eventId)`.
- **Importe y moneda** salen siempre de la reserva o del enlace, nunca del cliente. Un evento con importe o moneda distintos al `Payment` se rechaza (`amount_mismatch`) y avisa al staff.
- **Pago tardío**: un pago confirmado sobre una reserva vencida por falta de pago (`payment_timeout`) la reactiva si la salida sigue abierta y hay cupo; si no, o si una persona la canceló, se crea un `Refund` automático y se avisa al staff. Un pago de más (dos cobros simultáneos) reembolsa el excedente.
- **Webhooks a registrar**: ver "Pasos manuales" del informe de la Ola 2. Las firmas se validan sobre el cuerpo crudo (`modules/payments/raw-body.ts`).

### Comprobantes

`DocumentsService` crea el `Document` (serie y correlativo con `UPDATE … RETURNING` dentro de la transacción de la reserva, base e IGV con la tasa de `Company`, tipo de cambio de `ExchangeRateService` para USD) y deja el envío en la cola `DocumentJob` (en la base, sin Redis). `DocumentWorker` despacha la cola contra `desertica-billing` (`BillingClient`: `HttpBillingClient` sobre `openapi/billing.yaml`, `FakeBillingClient` con `BILLING_MODE=fake`) mandando **la misma petición y la misma `externalId`** en cada reintento (espera de 30 s que se duplica hasta 1 h, 10 intentos), guarda XML, CDR y PDF detrás de `DocumentStorage` (directorio local, `DOCUMENT_STORAGE_DIR`, fuera de Git) y sigue el estado hasta que SUNAT resuelve.

- Emisión automática al confirmarse un pago y nota de crédito automática al reembolsar (`Setting.autoIssueDocuments`, por defecto activo). Los pagos manuales los recoge el barrido del worker.
- Tipo de cambio: `Setting.exchangeRates` (por fecha) → `Setting.exchangeRateUsdPen` → `EXCHANGE_RATE_FALLBACK` (`3.7500`, no es el oficial: el contador define la fuente).
- El cliente baja el PDF con el enlace firmado de `PublicBooking.documents` (`GET /public/documents/{id}/pdf?exp&sig`, vale una hora).
- El worker corre cada `DOCUMENT_WORKER_SECONDS` (15) con un candado de Postgres; el certificado digital y la clave SOL no existen en este repo.

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

## Variables de entorno

Ver `.env.example`. Se validan al arrancar con un esquema Joi (`src/config/env.validation.ts`): si falta una obligatoria o tiene un valor inválido, la API no inicia.

| Variable | Descripción |
| --- | --- |
| `DATABASE_URL` | Conexión PostgreSQL (obligatoria) |
| `REDIS_URL` | Opcional. Sin ella el rate limit y las cachés usan memoria (una sola instancia) |
| `CORS_ORIGINS` | Orígenes permitidos separados por coma (obligatoria en producción) |
| `TRUST_PROXY` | Saltos de proxy confiables para leer la IP real (0 a 10); obligatoria en producción |
| `DB_POOL_MAX`, `DB_CONNECTION_TIMEOUT_MS`, `DB_STATEMENT_TIMEOUT_MS`, `DB_IDLE_IN_TX_TIMEOUT_MS` | Pool de Postgres y tiempos máximos (20, 5000, 30000 y 30000 por defecto) |
| `PUBLIC_WEB_URL`, `PUBLIC_API_URL` | Base de los enlaces de correo (web) y de descarga de comprobantes (API); `PUBLIC_WEB_URL` obligatoria en producción |
| `REFRESH_TTL_DAYS`, `REFRESH_REUSE_GRACE_SECONDS` | Vigencia del refresh token y ventana (20 s) en que reusar uno recién rotado no cuenta como robo |
| `TURNSTILE_SECRET_KEY` | Captcha de los endpoints públicos; obligatoria en producción |
| `STAFF_NOTIFY_EMAIL` | Destino de avisos internos (contacto, reclamos, alertas de cobros); obligatoria en producción |
| `PAYMENT_WINDOW_MINUTES`, `EXPIRY_SWEEP_SECONDS` | Plazo para pagar una reserva web y frecuencia del barrido de vencimientos |
| `THROTTLE_SCALE` | Multiplica los límites por IP; solo válida con `NODE_ENV=test` (la usan los e2e) |
| `PAYMENT_GATEWAY_MODE`, `STRIPE_*`, `CULQI_*`, `REFUND_SWEEP_SECONDS` | Pasarelas (`fake` solo en desarrollo y pruebas) y barrido de reembolsos |
| `BILLING_MODE`, `BILLING_URL`, `BILLING_SERVICE_TOKEN`, `BILLING_SUBMISSION`, `DOCUMENT_STORAGE_DIR`, `DOCUMENT_WORKER_SECONDS`, `EXCHANGE_RATE_FALLBACK` | Comprobantes (ver "Comprobantes") |
| `REFRESH_COOKIE_SECURE` | Atributo `Secure` de la cookie `desertica_refresh`; solo se puede apagar fuera de producción |
| `MAIL_DRIVER`, `SMTP_*`, `MAIL_FROM`, `MAIL_REPLY_TO` | Correo saliente (ver "Correo"); producción exige `smtp` con TLS |
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

La imagen corre como `node`, trae solo dependencias de producción (más `prisma`, `dotenv` y `tsx`, que usa `npx prisma migrate deploy`) y deja `/app/storage/documents` listo para `DOCUMENT_STORAGE_DIR`.

CI corre lint, unitarios, e2e (con Postgres 16) y el build en `.github/workflows/ci.yml`.

## Cloud Agents

`scripts/cloud-install.sh` instala dependencias y genera Prisma. `scripts/cloud-start.sh` levanta PostgreSQL, aplica migraciones y deja la API en `:3000`.

## Pendiente

Las Olas 1 y 2 (catálogo, reservas, pagos por pasarela, reembolsos, disputas y comprobantes) están implementadas; queda Google Calendar, WhatsApp y lo que dependa de claves reales, trámites o decisiones del negocio. El inventario de operaciones del contrato sin implementar sale con `SHOW_MISSING_OPERATIONS=1 npm run test:e2e -- test/routes`; el detalle está en `docs/PENDIENTES.md`.
