# Pendientes

Registro de todo lo que hay que hacer y **no se está haciendo ahora**. Cada punto indica quién lo hace y qué bloquea. Se actualiza en cada sesión de trabajo: lo que se hace se tacha, lo que aparece se agrega. El plan que origina esta lista está descrito en los ADRs y en `CLAUDE.md` de cada repo.

Repos: `desertica-web`, `desertica-cms`, `desertica-api` (este), `desertica-backoffice` y `desertica-billing` (los dos últimos por crear).

## Infraestructura y despliegue (diferido)

- [ ] Montar el VPS con Coolify y dimensionarlo para dos entornos. *Tú. Bloquea: salir a producción.*
- [ ] Entorno `staging` primero (claves de prueba, SUNAT beta, datos ficticios); clonar `production` cuando llegue el RUC.
- [ ] Postgres y Redis como servicios de Coolify; backups a R2/S3 fuera del VPS con restauración probada; runbooks de incidentes (webhook caído, SUNAT caído, pasarela caída).
- [ ] Almacenamiento de media y de comprobantes (R2/S3 o MinIO) con retención legal.
- [ ] Dominio, DNS, Cloudflare delante y TLS.
- [ ] Monitoreo: GlitchTip, Uptime Kuma, logs JSON y alertas.
- [ ] Actualizar `docs/DEPLOY.md` del CMS y de la web (hoy recomiendan Railway).

## Trámites que no son código

- [ ] RUC (llega en unos días). *Tú. Bloquea: todo lo fiscal y las altas de producción.*
- [ ] SUNAT: afiliar el RUC como emisor electrónico por sistema propio, registrar el certificado digital, crear un usuario SOL secundario con permiso solo de facturación electrónica y definir las series de boleta y factura. Los nombres exactos de cada trámite los confirma el contador.
- [ ] Obtener el certificado digital (firma) de un proveedor acreditado.
- [ ] Alta de producción en Culqi y en Stripe (entidad extranjera y/o peruana). Verificar si Stripe acepta una cuenta peruana, si Culqi ofrece algo equivalente a Apple Pay y Google Pay en soles, y verificar el dominio para Apple Pay.
- [ ] Meta Business y Pixel; en v2, WhatsApp Business API (aprobación de plantillas).
- [ ] Cuentas de GA4, GTM y Search Console; Google Workspace (calendario, login de staff, correo).

## Negocio y contenido

- [ ] Precios finales por moneda (USD y PEN, con IGV incluido), capacidades, horarios y puntos de encuentro por tour.
- [ ] Fichas completas de los 14 tours pendientes (hoy solo `dune-buggy`), fotos y videos reales; reemplazar los `XXXX` de contacto.
- [ ] Política de cancelación y reembolso definitiva.

## Legal y cumplimiento

- [ ] Abogado: términos y condiciones, privacidad (Ley 29733), conducta, descargo de responsabilidad y Libro de Reclamaciones.
- [ ] Licencias y seguros del operador turístico (MINCETUR, permisos locales, seguro de pasajeros).

## Contador

- [ ] Tratamiento tributario de depósito y saldo (anticipos), para diseñar `Document`.
- [ ] Tipo de cambio SUNAT para comprobantes en USD y tope de boletas con identificación del cliente.
- [ ] Catálogos de SUNAT (motivos de nota de crédito y débito, afectación del IGV): `desertica-billing` los contrastó con una fuente de 2017 y con Greenter porque no pudo leer el Anexo 8 oficial; confirmar.
- [ ] Unidad de medida de los tours (hoy `NIU`; ¿`ZZ` para servicios?) y si aplica la leyenda 2004 «Agencia de Viaje – Paquete turístico».
- [ ] Si habrá boletas sin identificar al cliente (hoy el receptor es obligatorio).
- [ ] Contabilidad (standby): exportación CSV de ventas y pagos, reporte de conciliación con Stripe y Culqi, formato PLE y alerta de vencimiento del certificado.

## Producto: v2 (después de las primeras ventas)

- [ ] Evidencia de contracargos generada automáticamente.
- [ ] Conversions API de Meta y Measurement Protocol de GA4 desde el servidor.
- [ ] Lista de espera y códigos promocionales.
- [ ] WhatsApp Business API para confirmaciones.
- [ ] Sincronización con Google Calendar y manifiesto automático para guías; rol Guía.
- [ ] Cuentas de cliente con magic link, reseñas, búsqueda de DNI/RUC y canal ARCO automatizado.
- [ ] Cancelación por el cliente desde "mi reserva": endpoint público con reembolso calculado por la política. Hasta entonces cancela el staff, y el evento `cancel_booking` queda sin uso.

## Producto: opcional (solo con demanda real)

- [ ] Venta a agencias con precios y comisiones B2B.
- [ ] Tours privados con reglas de precio complejas (se arranca con precio por grupo simple).
- [ ] Clarity/Hotjar y píxeles de TikTok o Google Ads.
- [ ] Segundo servidor o alta disponibilidad.

## Descartado

- Migración de reservas del CMS: el negocio es nuevo y no hay histórico.

## CI (la sesión cloud no puede modificar workflows de GitHub Actions)

- [ ] En `desertica-api`, añadir a `.github/workflows/ci.yml`, después de `npm run lint`, los pasos `npm run openapi:lint` y `npx prisma validate`. *Tú (requiere permiso `workflow`).*
- [ ] Crear los workflows de CI e imagen Docker de `desertica-backoffice` y `desertica-billing` (copiar el patrón de `desertica-api` y `desertica-web`).

## API: lo que queda de la Ola 1 y de la Ola 2

Hecho en la Ola 1: fundaciones, auth y permisos, catálogo, reservas, cumplimiento y la prueba de conformidad con el contrato. Faltan 31 de las 93 operaciones del contrato (se listan con `SHOW_MISSING_OPERATIONS=1 npm run test:e2e -- test/routes`):

- [ ] **Pasarelas (Ola 2)**: `createBookingStripeIntent`, `createBookingCulqiCharge`, `createLinkStripeIntent`, `createLinkCulqiCharge`, `receiveStripeWebhook`, `receiveCulqiWebhook`, interfaz `PaymentProvider` con adaptadores `stripe` y `culqi`, `WebhookEvent` idempotente. El webhook debe reutilizar `BookingPaymentsService.applySucceededPayment` con la reserva bloqueada.
- [ ] **Pago que llega después del vencimiento (Ola 2)**: `ExpiryService` cancela la reserva web sin pago al vencer la ventana (salvo pago en curso); si el webhook confirma un pago sobre una reserva ya cancelada hay que reactivarla si hay cupo o reembolsar. Definir y probar.
- [ ] **Reembolsos (Ola 2)**: `createRefund`, `listRefunds`. Hoy la cancelación y la reprogramación solo crean filas `Refund` en `PENDING` (repartidas entre pagos, del más reciente al más antiguo); nada las ejecuta ni actualiza `paidCents`/`refundedCents`. Tope de reembolso del operador (`operatorRefundLimitCents`) y `payments:refund-any` por aplicar ahí.
- [ ] **Comprobantes (Ola 2)**: `issueDocument`, `listDocuments`, `getDocument`, `retryDocument`, `voidDocument`, `createCreditNote`, `downloadDocumentFile`; cliente de `desertica-billing`; `PublicBooking.documents` hoy siempre vacío.
- [ ] **Pagos y disputas, solo lectura/edición**: `listPayments`, `getPayment`, `listDisputes`, `getDispute`, `updateDispute`, `downloadDisputeEvidence`.
- [ ] **Administración sin asignar a un hito**: `getCompany`/`saveCompany`, `listSeries`/`createSeries`, `listBlockedIdentities`/`createBlockedIdentity` (y aplicar los bloqueos al reservar), `getDashboardSummary`, `getSalesReport`, `eraseCustomer` (ARCO), `cancelDeparture` (cancelar una salida y reembolsar/reprogramar sus reservas).
- [x] **Cancelar desde "mi reserva"**: decidido para v2 (ver arriba).
- [ ] **Mensajes de contacto**: se guardan en `ContactMessage` y avisan a `STAFF_NOTIFY_EMAIL`, pero el contrato no tiene operación para listarlos ni marcarlos atendidos.
- [ ] **Correo real**: hoy `LogMailer` escribe en el log. Falta el driver (SMTP/API de correo) y las plantillas (`booking_created`, `booking_confirmed`, `booking_cancelled`, `booking_rescheduled`, `booking_expired`, `booking_access`, `payment_link`, `complaint_received`, `complaint_answered`, `complaint_staff_alert`, `contact_message`).
- [ ] **Rutas de los enlaces de correo**: el API arma `/booking/<ref>?token=`, `/waiver/<token>` y `/pay/<token>` sobre `PUBLIC_WEB_URL` (`modules/bookings/links.ts`). `desertica-web` debe implementarlas o avisar para cambiarlas.
- [ ] **Redis en producción**: el rate limit y la caché del CMS usan memoria si no hay `REDIS_URL`; con más de una instancia hay que configurarlo.
- [ ] **Turnstile**: sin `TURNSTILE_SECRET_KEY` no se verifica el captcha. Configurarlo en staging y producción.
- [ ] **Depósito**: el porcentaje vive en `Setting.depositPercent` (30 %); el CMS tiene `booking-setting.depositRate`. Dejar una sola fuente (el dinero es del API) y quitar el otro.
- [ ] **Texto del descargo**: `Waiver.version` es 1 fijo y el texto del descargo no se guarda como snapshot (solo los documentos legales). Definir cómo se versiona (¿tipo `WAIVER` en `LegalDocument`?) antes de generar el PDF firmado.
- [ ] **Política de cancelación**: un tour sin política asignada se reserva con "sin reembolso" (`tiers: []`). Asignar una a todos los tours antes de vender; considerar exigirla en la publicación.
- [ ] **Reclamos**: el plazo se cuenta en días hábiles (lunes a viernes, sin feriados) con `complaintDueDays` = 15. Confirmar con el abogado si son 15 hábiles o 30 corridos y cargar los feriados.
- [ ] **Bloqueos de cupo**: el tope es 8 bloqueos por IP cada 15 minutos más captcha; un atacante con muchas IP aún puede retener cupo. Evaluar un tope de bloqueos activos por salida o validación previa.
- [ ] **"Mi reserva"**: el correo con enlace tarda más cuando la referencia y el correo coinciden; para igualar la latencia hay que encolar el envío.
- [ ] **ARCO**: `eraseCustomer` no puede borrar datos personales de `AuditLog` (inmutable). La auditoría de clientes ya guarda solo nombres de campos; mantener ese criterio en lo nuevo.
- [ ] **Imagen Docker**: se verificó el `build` de Nest pero no `docker build` (no había daemon). La imagen incluye devDependencies porque el CLI de Prisma se usa para migrar.

## Documentación

- [ ] ADRs de las decisiones del plan.
- [x] `CLAUDE.md` de `desertica-api`, `desertica-backoffice` y `desertica-billing`.

## Entorno cloud (a configurar antes de las sesiones en paralelo)

- [ ] Permitir en la red del entorno los hosts de Stripe (test), Culqi (sandbox), SUNAT beta, Google, Meta y los registros de paquetes (Packagist, npm).
- [ ] Instalar PHP 8.3, Composer, Redis y Postgres en el script de configuración del entorno.
- [ ] Guardar las claves de prueba como secretos del entorno. El certificado digital y la clave SOL reales no van a cloud.
- [x] Crear los repos `desertica-backoffice` y `desertica-billing` y añadirlos a las sesiones.
