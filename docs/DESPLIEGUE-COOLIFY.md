# Despliegue en un VPS con Coolify

Guía para montar Desertica en un solo servidor con Coolify, **por fases**. Hoy solo toca la primera: la **landing y el CMS**. El API, los pagos, la facturación y el backoffice se despliegan después, cuando estén verificados. Todo lo que está aquí sale de los `Dockerfile`, `.env.example` y la validación de entorno de cada repo en las ramas de la Ola 2. Las cifras de memoria y disco son **estimaciones**: se miden en staging con `docker stats` y se ajusta esta guía.

> Nada de esto se ha ejecutado todavía. Es la primera vez que las imágenes se construyen y se levantan juntas, así que habrá ajustes. Staging existe para encontrarlos antes de que lo vea el público.

## 0. Fases

| Fase | Qué se despliega | Qué se verifica | Requisitos |
|---|---|---|---|
| **1. Landing y CMS (ahora)** | PostgreSQL, `desertica-cms`, `desertica-web` | Contenido desde el CMS, SEO, consentimiento y GTM, formularios de contacto y reserva por WhatsApp | Dominio, servidor, Cloudflare. Sin RUC, sin pasarelas. |
| 2. API y backoffice | `desertica-api`, `desertica-backoffice` | Login con Google, catálogo, reservas manuales, correo | Client id de Google, relay SMTP, Turnstile |
| 3. Pagos y facturación | `desertica-billing`, Stripe y Culqi en el API | Cobros de prueba, 3DS, Apple Pay, comprobantes en SUNAT beta | Claves de prueba, red hacia las pasarelas y SUNAT beta, imágenes construidas |
| 4. Producción con ventas | Todo, entorno `production` | Un cobro real de monto mínimo con su comprobante y reembolso | RUC, certificado y clave SOL reales, textos legales y descargos |

Cada fase se prueba primero en **staging** y, si pasa, se repite en producción. Las secciones 1 a 4 describen el servidor y la landing; las secciones 5 en adelante son para las fases 2 a 4 y se pueden ignorar por ahora.

## Fase 1: landing y CMS

### Qué incluye y qué no

- **Sí**: PostgreSQL (solo la base del CMS), `desertica-cms` y `desertica-web`, con Uptime Kuma para vigilar.
- **No**: `desertica-api`, `desertica-billing` y `desertica-backoffice`.
- La web se despliega con **`BOOKING_ENGINE_ENABLED=false`** y **sin `API_URL`**. El flujo de reservas sigue siendo el de hoy: el formulario guarda la solicitud en el CMS y abre WhatsApp. Los mensajes de contacto también van al CMS.
- Recursos estimados de la fase: 4 a 5 GB de RAM y menos de 20 GB de disco. El servidor sobra.

### Antes de empezar

1. Fusionar los PRs del CMS (#1, luego #2) y de la web (#6, luego #7, que va hacia `develop`). Con la bandera apagada, el código del motor de reservas queda inactivo.
2. Que las imágenes `ghcr.io/desertica/desertica-cms` y `ghcr.io/desertica/desertica-web` se publiquen desde sus workflows (ya existen).
3. Preparar el servidor (sección 2) y los dominios de la sección 3 (solo los de web y CMS).
4. Una cuenta de Cloudflare R2 (o S3) si los videos y las fotos del CMS van a un bucket; recomendado, porque el disco local no es un buen lugar para videos.

### Orden

1. Crear en Coolify el proyecto y el entorno `staging`, y un PostgreSQL con la base `desertica_cms` y su propio usuario.
2. **CMS**: variables de la sección 5.4, `SEED_ON_EMPTY=true` la primera vez. Esperar `/_health`, crear el administrador en `/admin`, generar los tokens de API (uno de solo lectura para la web y otro para los formularios) y poner `SEED_ON_EMPTY=false`.
3. **Web**: variables de la sección 5.3 (sin `API_URL`; con `NG_ALLOWED_HOSTS`, `STRAPI_URL`, `STRAPI_PUBLIC_URL`, `STRAPI_API_TOKEN`, `FORMS_PROXY_SECRET` igual al del CMS, `TRUST_PROXY=true`, `SITE_URL`, `ROBOTS_DISALLOW_ALL=true` en staging).
4. Cargar el contenido real en el CMS: datos de contacto (hoy son `XXXX`), tours y textos. Lo publicado aparece en la web en unos 30 segundos, sin reconstruir.
5. Verificar en staging (lista de abajo) y repetir en producción con `ROBOTS_DISALLOW_ALL=false`.

### Verificación de la landing en staging

- Las páginas muestran el contenido del CMS; publicar un cambio y verlo reflejado.
- Cambio de idioma `es` y `en` (hoy por cookie y `?lang=`) y etiquetas `hreflang` correctas.
- `sitemap.xml` y `robots.txt`; en staging el sitio no se indexa.
- Banner de cookies: sin consentimiento no se carga ninguna etiqueta; con consentimiento, GTM dispara los eventos de `docs/analytics-events.md`. Para probarlo, un `GTM_ID` de staging.
- Formulario de contacto: llega a la bandeja del CMS. Formulario de reserva: se guarda en el CMS y abre WhatsApp.
- El límite de peticiones del proxy de formularios cuenta la IP del visitante y no la del proxy (ver la sección 10, punto 1, y `TRUST_PROXY`).
- Rendimiento (Lighthouse) y que el health check quede sano (`NG_ALLOWED_HOSTS`).

### Decisión pendiente: el Libro de Reclamaciones

El pie de la web enlaza a `/complaints`, y ese formulario **se envía al API**. Sin API desplegado responde 503 (`api_disabled`) y la persona que intente presentar un reclamo ve un error. Es un tema legal, no solo técnico. Opciones:

| Opción | Cómo | A favor | En contra |
|---|---|---|---|
| A. Texto provisional | Mientras no haya API, `/complaints` muestra la página legal del CMS con el procedimiento (correo y WhatsApp), y el formulario se activa con el API. Requiere un ajuste pequeño en la web: sin `API_URL`, esa ruta renderiza la página del CMS. | Se puede lanzar ya | El abogado debe aceptar el procedimiento provisional |
| B. Adelantar el API | Desplegar el API (fase 2) antes de abrir la landing al público | Libro de Reclamaciones completo desde el día uno | Retrasa la landing hasta tener Google, SMTP y Turnstile |
| C. Lanzar sin enlace | Quitar el enlace del pie hasta tener el API | Cero errores visibles | Probablemente incumple la obligación de tener el Libro disponible |

Mi recomendación es A, **si el abogado lo valida**; si no, B. La opción C no la recomiendo. Falta que decidas.

## 1. El servidor

Plan previsto: 6 vCores, 24 GB de RAM, 180 GB NVMe, puerto de 250 Mbit/s con tráfico ilimitado.

| Recurso | Cabe | Comentario |
|---|---|---|
| CPU (6 vCores) | Sí, con holgura | El uso es bajo salvo al construir imágenes. **Construir en CI, no en el servidor** (ver §6). |
| RAM (24 GB) | Sí, dos entornos completos | Estimado en régimen: 12 a 14 GB (tabla abajo). Quedan 10 GB para picos y caché de disco. |
| Disco (180 GB) | Sí, si se limpia | Lo que más crece: imágenes Docker viejas, logs y videos. Los videos y fotos van a R2/S3, no al disco. |
| Red (250 Mbit/s) | Sí | La media pesada sale por Cloudflare/R2. |

**Presupuesto de memoria estimado con todas las fases desplegadas (staging + producción).** La fase 1 usa solo PostgreSQL, CMS, web y monitoreo básico, unos 4 a 5 GB:

| Servicio | Producción | Staging |
|---|---|---|
| Coolify, Traefik y Docker | 1,5 GB | (compartido) |
| PostgreSQL 16 | 3 GB | 1 GB |
| Redis (opcional, ver §9) | 0,25 GB | 0 |
| `desertica-cms` (Strapi) | 1,2 GB | 1 GB |
| `desertica-api` (NestJS) | 0,5 GB | 0,4 GB |
| `desertica-web` (Angular SSR) | 0,6 GB | 0,4 GB |
| `desertica-billing` (nginx + php-fpm) | 0,4 GB | 0,3 GB |
| `desertica-backoffice` (nginx) | 0,05 GB | 0,05 GB |
| Monitoreo (Uptime Kuma, GlitchTip) | 1,5 GB | (compartido) |
| **Total aproximado** | **9 GB** | **3,2 GB** |

Con picos y caché, 12 a 14 GB. Si algo se acerca a 20 GB, no es normal: investigar antes de subir de plan.

**Región del servidor.** Elige la más cercana a Perú que ofrezca tu proveedor (por lo general, la costa este de EE. UU. da menos latencia que Europa). La latencia se nota en el SSR y en las llamadas web-API.

## 2. Preparar el servidor (una vez)

1. Acceso solo por **llave SSH**; desactivar contraseña y login de root por contraseña.
2. **Firewall**: abrir 22 (limitado a tu IP si es posible), 80 y 443. Nada más. Postgres, Redis, billing y el panel de Coolify no se publican al exterior; el panel de Coolify se sirve por un dominio propio con HTTPS y 2FA.
3. **Swap de 4 GB** como red de seguridad, no como capacidad.
4. **Rotación de logs de Docker** (`max-size 10m`, `max-file 3`): sin esto los logs llenan el disco. Es el fallo más común en servidores de un solo nodo.
5. Actualizaciones de seguridad automáticas y `fail2ban` para SSH.
6. Instalar Coolify con su script oficial y, como primer paso, fijar el dominio del panel y activar 2FA. Confirma los pasos en la documentación de tu versión.
7. Programar `docker system prune` (imágenes sin usar, nunca volúmenes) una vez por semana.

## 3. Dominios y cookies

La sesión del backoffice usa una cookie `SameSite=Strict`: **el backoffice y el API deben estar bajo el mismo dominio registrable** (por ejemplo `admin.` y `api.` del mismo dominio). Si no, el navegador descarta la cookie y nadie puede iniciar sesión.

| Servicio | Producción | Staging |
|---|---|---|
| Sitio web | `<dominio>` y `www.<dominio>` | `stg.<dominio>` |
| API | `api.<dominio>` | `api-stg.<dominio>` |
| Backoffice | `admin.<dominio>` | `admin-stg.<dominio>` |
| CMS | `cms.<dominio>` | `cms-stg.<dominio>` |
| Billing | sin dominio público | sin dominio público |

Usa nombres de un solo nivel (`api-stg.` y no `api.stg.`): el certificado gratuito de Cloudflare cubre solo un nivel de subdominio. Con Cloudflare delante, activa el modo "Full (strict)" y deja que Coolify (Traefik) emita el certificado del origen.

## 4. Servicios

| Servicio | Imagen | Puerto | Salud | Público | Datos que hay que conservar |
|---|---|---|---|---|---|
| PostgreSQL 16 | recurso "Database" de Coolify | 5432 | — | **No** | Todo: bases `desertica_api` y `desertica_cms` |
| Redis | recurso de Coolify | 6379 | — | **No** | Nada importante (límite de peticiones y caché) |
| `desertica-cms` | `ghcr.io/desertica/desertica-cms` | 1337 | `GET /_health` | Sí (admin y media) | `public/uploads` si no usas R2 |
| `desertica-api` | construir (aún sin workflow, ver §6) | 3000 | `GET /api/health` | Sí | Comprobantes en `DOCUMENT_STORAGE_DIR` |
| `desertica-billing` | construir (aún sin workflow) | 8080 | `GET /health` | **No** | `/var/lib/billing` (SQLite y archivos) y el certificado |
| `desertica-web` | `ghcr.io/desertica/desertica-web` | 4000 | `GET /` | Sí | Nada |
| `desertica-backoffice` | construir (aún sin workflow) | 8080 | `GET /healthz` | Sí | Nada |

Todos los contenedores corren sin root. Billing y la base de datos solo se alcanzan por la red interna de Docker de Coolify.

## 5. Variables de entorno

Los valores **secretos** se cargan como secretos de Coolify y nunca van a Git. Aquí solo se listan los nombres y qué hacen.

### 5.1 `desertica-api`

El API valida el entorno al arrancar y **se niega a iniciar** si falta algo obligatorio.

| Variable | Producción y staging | Notas |
|---|---|---|
| `NODE_ENV` | `production` | **También en staging**: ver el recuadro de abajo. |
| `DATABASE_URL` | obligatoria | `postgresql://…@<host interno>:5432/desertica_api` |
| `JWT_ACCESS_SECRET` | obligatoria, secreto | Cadena larga aleatoria, distinta por entorno. |
| `GOOGLE_CLIENT_ID` | obligatoria | Login del backoffice. |
| `ALLOWED_EMAIL_DOMAIN` | por defecto `desertica.pe` | Dominio de Google Workspace de la empresa. |
| `CORS_ORIGINS` | obligatoria | Origen del backoffice (`https://admin.<dominio>`). Lista separada por comas. |
| `PUBLIC_WEB_URL` | obligatoria | Base de los enlaces de los correos (`/booking`, `/waiver`, `/pay`). |
| `PUBLIC_API_URL` | recomendada | Base del enlace firmado del PDF del comprobante. |
| `TRUST_PROXY` | número de saltos | Con Cloudflare y Traefik delante son 2. Ver §10. |
| `REFRESH_COOKIE_SECURE` | `true` | En producción no admite otro valor. |
| `TURNSTILE_SECRET_KEY` | obligatoria, secreto | En staging, las claves de prueba de Turnstile. |
| `MAIL_DRIVER` | `smtp` | Obligatorio en producción. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `MAIL_FROM` | obligatorias | Relay de Google Workspace; `MAIL_REPLY_TO` y `STAFF_NOTIFY_EMAIL` opcionales. |
| `CMS_URL`, `CMS_API_TOKEN` | URL interna del CMS | Token de solo lectura. |
| `PAYMENT_GATEWAY_MODE` | `live` | Obligatorio en producción. En staging se usan **claves de prueba**, no un modo simulado. |
| `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET` | secretos | Claves `test` en staging. |
| `CULQI_SECRET_KEY`, `CULQI_PUBLIC_KEY`, `CULQI_WEBHOOK_SECRET` | secretos | Claves de integración en staging. |
| `BILLING_MODE` | `live` | Obligatorio en producción. |
| `BILLING_URL`, `BILLING_SERVICE_TOKEN` | URL interna y secreto | El mismo token que `BILLING_SERVICE_TOKEN` de billing. |
| `DOCUMENT_STORAGE_DIR` | ruta de un volumen | Montar un volumen persistente ahí. |
| `EXCHANGE_RATE_FALLBACK` | opcional | No es oficial; el tipo de cambio de SUNAT lo debe definir el contador. |
| `REDIS_URL` | opcional | Ver §9. |

> **Por qué staging también es `NODE_ENV=production`.** En producción el API rechaza `PAYMENT_GATEWAY_MODE=fake`, `BILLING_MODE=fake`, `AUTH_ALLOW_FAKE_GOOGLE=true` y exige Turnstile y Google reales. Eso es deliberado (protege producción de una mala configuración), pero implica que **staging necesita de verdad**: un client id de Google, claves de prueba de Stripe y de Culqi, y un billing levantado contra SUNAT beta.

### 5.2 `desertica-billing`

| Variable | Notas |
|---|---|
| `BILLING_ENV` | `BETA` en staging, `PRODUCTION` solo con certificado y clave SOL reales. Es explícito y aparece en `/health`. |
| `BILLING_GATEWAY` | `greenter` (el real) o el simulado, que no se usa en producción. |
| `BILLING_SERVICE_TOKEN` | Secreto compartido con el API. |
| `BILLING_CERT_PATH`, `BILLING_CERT_PASSWORD` | Ruta del certificado `.pfx` **montada como archivo secreto** y su clave. En staging, un certificado de prueba. |
| `BILLING_SOL_USER`, `BILLING_SOL_PASSWORD` | Usuario SOL secundario. En staging, las credenciales públicas de beta. |
| `BILLING_ISSUER_*` | RUC, razón social, dirección, ubigeo, distrito, provincia y departamento del emisor. |
| `BILLING_STORAGE_DIR`, `BILLING_DB_DSN` | Volumen `/var/lib/billing`. |
| `BILLING_UNIT_CODE`, `BILLING_LEGEND_2004`, `BILLING_ANONYMOUS_BOLETA_MAX_CENTS`, `BILLING_BOLETA_SUBMISSION` | Decisiones del contador, con valores por defecto seguros. |
| `BILLING_SUNAT_CA_FILE` | Solo si la cadena TLS de SUNAT no valida con la imagen. No hay interruptor para apagar la verificación. |

El certificado digital y la clave SOL **reales** solo existen en el servidor de producción. Nunca se cargan en sesiones cloud ni en Git.

### 5.3 `desertica-web`

| Variable | Notas |
|---|---|
| `NG_ALLOWED_HOSTS` | **Obligatoria**: los dominios que responde (`<dominio>,www.<dominio>`). Cualquier otro `Host` recibe 400. El health check usa `localhost`, que ya está permitido. |
| `STRAPI_URL`, `STRAPI_PUBLIC_URL`, `STRAPI_API_TOKEN` | URL interna del CMS, URL pública para el media y token de lectura. |
| `API_URL` | URL del API (interna o pública, ver §10). |
| `BOOKING_ENGINE_ENABLED` | `false` hasta terminar la verificación de pagos; con `true` se activa el motor nuevo. |
| `CULQI_PUBLIC_KEY`, `GTM_ID`, `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY` | Públicas las tres primeras; la última es secreta. |
| `FORMS_PROXY_SECRET`, `STRAPI_FORMS_TOKEN` | El mismo valor que en el CMS. |
| `TRUST_PROXY` | `true` detrás de Traefik. |
| `SITE_URL` | URL canónica del sitio. |
| `ROBOTS_DISALLOW_ALL` | `true` **en staging** para que Google no lo indexe. |

### 5.4 `desertica-cms`

`APP_KEYS`, `ADMIN_JWT_SECRET`, `API_TOKEN_SALT`, `TRANSFER_TOKEN_SALT`, `ENCRYPTION_KEY` y `JWT_SECRET` (seis secretos, únicos por entorno); `DATABASE_URL` (o `DATABASE_CLIENT=postgres` con host, usuario y contraseña); `PUBLIC_URL`; `CLIENT_URLS` (CORS); `PROXY=true`; `FORMS_PROXY_SECRET`; `SEED_ON_EMPTY=true` solo la primera vez. Para media, `UPLOAD_PROVIDER` con `S3_*` apuntando a R2 (recomendado) o un volumen en `public/uploads`.

### 5.5 `desertica-backoffice`

`API_BASE_URL` (`https://api.<dominio>/api`), `API_ORIGIN` (`https://api.<dominio>`, para la política CSP) y `GOOGLE_CLIENT_ID`.

## 6. Cómo se construyen las imágenes

**No construyas en el servidor.** Compilar Angular y el panel de Strapi consume varios GB y puede dejar sin memoria a producción. La opción recomendada: GitHub Actions construye y publica en GHCR, y Coolify solo descarga la imagen etiquetada.

- `desertica-web` y `desertica-cms` ya tienen workflow de imagen.
- **Faltan** los de `desertica-api`, `desertica-backoffice` y `desertica-billing`. Esta cuenta no puede escribir workflows; hay que copiar el patrón de `desertica-web`. En billing el job necesita PHP 8.3 con `ext-soap`, `composer check` y `hadolint` antes del `docker build`.
- Etiqueta cada imagen con `sha-<commit>` y despliega por etiqueta, no por `latest`, para poder volver atrás.

## 7. Orden de despliegue (staging)

1. **Red y base de datos**: crear el proyecto y el entorno `staging` en Coolify; crear PostgreSQL con las bases `desertica_api` y `desertica_cms` y usuarios distintos.
2. **CMS**: desplegar con `SEED_ON_EMPTY=true`; esperar `/_health`; crear el primer administrador en `/admin`; generar un token de API de solo lectura; después poner `SEED_ON_EMPTY=false`.
3. **Billing**: desplegar con el volumen y el certificado de prueba montados; comprobar `/health` desde otro contenedor y que muestre `BETA`.
4. **API**: antes de iniciar, ejecutar las migraciones como comando previo al despliegue: `npx prisma migrate deploy` (la imagen incluye la CLI de Prisma; el API **no** migra al arrancar). Primera vez: `npm run prisma:seed` (roles, administrador desde `SEED_ADMIN_EMAIL`), luego `POST /api/tour-refs/sync` con una sesión de administrador.
5. **Web**: desplegar con `BOOKING_ENGINE_ENABLED=false`.
6. **Backoffice**: desplegar y entrar con una cuenta del dominio de Google Workspace.
7. En el backoffice: cargar la **empresa** y las **series** (`B001`, `F001` y, para notas de crédito, `BC01` y `FC01`; la letra inicial de la nota debe coincidir con el comprobante afectado), asignar una **política de cancelación** a cada tour y **publicar el descargo** de cada tour. Sin descargo publicado, reservar ese tour responde 409; sin series, emitir responde 409.
8. Recién entonces, `BOOKING_ENGINE_ENABLED=true` en staging.

## 8. Webhooks y terceros

| Qué | Dónde | Detalle |
|---|---|---|
| Stripe | Panel de Stripe (modo prueba), URL `https://api-stg.<dominio>/api/webhooks/stripe` | Eventos: `payment_intent.succeeded`, `.payment_failed`, `.canceled`, `.requires_action`; `refund.created`, `.updated`, `.failed`; `charge.dispute.created`, `.updated`, `.closed`, `.funds_withdrawn`, `.funds_reinstated`. El secreto va en `STRIPE_WEBHOOK_SECRET`. |
| Culqi | Panel de Culqi, URL `https://api-stg.<dominio>/api/webhooks/culqi` | La forma de firmar el webhook **no está confirmada** con la documentación de Culqi (hoy se asume HMAC en `x-culqi-signature`). Verificar con un evento real antes de confiar en él. |
| Google (login) | Consola de Google Cloud | Cliente OAuth tipo "Aplicación web"; origen JS autorizado = URL del backoffice. |
| Apple Pay | Panel de Stripe | Registrar el dominio del sitio y publicar el archivo de verificación que Stripe entrega, en la raíz del sitio. |
| Correo | Admin de Google Workspace | Autorizar la IP del servidor en el relay SMTP y configurar SPF, DKIM y DMARC del dominio. |
| Turnstile | Panel de Cloudflare | Claves de sitio y secreta por entorno. |
| GTM, GA4, Meta | Sus paneles | `GTM_ID` en la web; el Pixel de Meta se configura dentro de GTM. |

## 9. Redis: ¿hace falta?

No para funcionar. Sin `REDIS_URL` el límite de peticiones y la caché del CMS viven en memoria de cada proceso. Con **una sola instancia del API** eso es aceptable; Redis solo se vuelve necesario al correr más de una instancia. Por eso se puede arrancar sin Redis y añadirlo después sin cambiar código. Ojo: la cola interna de "mi reserva" también es en memoria; un reinicio pierde lo pendiente.

## 10. Puntos delicados a verificar en staging

1. **IP real del visitante.** El API limita por IP y cuenta saltos de proxy con `TRUST_PROXY`. El tráfico directo del navegador al API pasa por Cloudflare y Traefik (2 saltos), pero las llamadas de la web al API pueden entrar por otra ruta (red interna: 1 salto). Hay que comprobar en los logs qué IP ve el API en cada caso y fijar `API_URL` y `TRUST_PROXY` en consecuencia. Si todos los visitantes aparecen con la misma IP, el límite de peticiones los bloqueará a todos a la vez.
2. **Cookie de sesión**: iniciar sesión en el backoffice desde un navegador real y recargar la página; si pide login de nuevo, la cookie no se está guardando (dominio o `Secure`).
3. **Health check de la web**: si el despliegue nunca queda sano, revisar `NG_ALLOWED_HOSTS`.
4. **Construcción de imágenes**: ninguna se ha construido todavía en un Docker real. Verificar sobre todo billing (nginx + php-fpm sin root, con sistema de archivos de solo lectura) y que los nombres de paquetes de Debian existan.
5. **SUNAT beta**: probar una emisión real, la lectura del CDR y el caso "comprobante ya registrado". El código de error exacto de ese caso viene de una fuente de terceros y es configurable (`BILLING_ALREADY_REGISTERED_CODES`).
6. **Culqi**: 3DS, firma del webhook, reembolsos y el tipo del monto, que no se contrastaron con su documentación.
7. **Stripe con Apple Pay y Google Pay** en un teléfono real, con el dominio verificado.
8. **Peso real de cada servicio** con `docker stats` durante una prueba de carga corta; actualizar §1.

## 11. Respaldos y recuperación

Un solo servidor es un punto único de falla. Los respaldos tienen que salir del servidor.

| Qué | Con qué | Frecuencia | Destino |
|---|---|---|---|
| PostgreSQL (`desertica_api`, `desertica_cms`) | Respaldo programado de Coolify o `pg_dump` | Diario, retención 14 días | R2/S3 fuera del servidor |
| Comprobantes del API (`DOCUMENT_STORAGE_DIR`) | `rclone`/`restic` | Diario | R2/S3 |
| Billing (`/var/lib/billing`) | ídem | Diario | R2/S3 |
| Media del CMS | R2 como almacenamiento principal; si es disco local, igual que arriba | — | R2/S3 |
| Secretos y certificado digital | Gestor de contraseñas de la empresa | Al cambiar | Fuera del servidor |
| Instantánea del proveedor | Panel del proveedor | Semanal | — |

**Una restauración que nunca se probó no es un respaldo.** Antes de producción, restaurar la base y los comprobantes en un servidor limpio y comprobar que el API arranca. Los comprobantes electrónicos (XML, CDR y PDF) tienen retención legal: no los pierdas.

## 12. Monitoreo

- **Uptime Kuma**: monitores sobre `https://api.<dominio>/api/health`, el sitio, el CMS (`/_health`) y el backoffice (`/healthz`); alertas al correo y al celular.
- **GlitchTip** (compatible con Sentry) para errores del API y de la web. Pesa más que el resto del monitoreo; si falta memoria, es lo primero que se pospone.
- Alertas internas que ya envía el API al staff (`STAFF_NOTIFY_EMAIL`): pago tardío sobre una reserva vencida, comprobante sin series o en error, reembolso que no se pudo ejecutar.
- Vigilar: disco libre (alerta al 75 %), memoria y la expiración del certificado digital.

## 13. Paso a producción (cuando llegue el RUC)

1. Crear el entorno `production` en Coolify con dominios, bases y volúmenes propios.
2. Cargar el certificado real y la clave SOL **solo** en billing de producción; `BILLING_ENV=PRODUCTION` y `BILLING_ISSUER_*` con los datos reales.
3. Claves **de producción** de Stripe y Culqi, y registrar de nuevo los webhooks con las URLs de producción.
4. Cargar la `Company` real y las series reales; revisar los textos legales con el abogado.
5. Un **cobro real de monto mínimo**, su comprobante en SUNAT, un reembolso y la nota de crédito. Solo después se abre la venta.
6. `ROBOTS_DISALLOW_ALL=false` y enviar el sitemap a Search Console.
7. Probar una restauración desde los respaldos.
