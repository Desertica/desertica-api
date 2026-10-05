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

Hecho en la Ola 1: fundaciones, auth y permisos, catálogo, reservas, cumplimiento y la prueba de conformidad con el contrato. Hecho en la Ola 2: API-A (conformidad con el contrato reconciliado, administración, correo real, descargos versionados y endurecimiento) y API-B (pagos por pasarela, reembolsos, disputas y comprobantes). Las 98 operaciones del contrato están implementadas (se comprueba con `SHOW_MISSING_OPERATIONS=1 npm run test:e2e -- test/routes`). Lo que sigue sin tachar es trabajo que depende de claves, red, trámites o decisiones del negocio:

- [x] **Pasarelas (Ola 2)**: `createBookingStripeIntent`, `createBookingCulqiCharge`, `createLinkStripeIntent`, `createLinkCulqiCharge`, `receiveStripeWebhook`, `receiveCulqiWebhook`, interfaz `PaymentGateway` con adaptadores `StripeGateway`, `CulqiGateway` y `FakeGateway`, `WebhookEvent` idempotente. Probado solo con la pasarela simulada, firmas generadas en local y servidores HTTP de prueba: **ninguna llamada a Stripe o Culqi reales** (hosts bloqueados).
- [x] **Pago que llega después del vencimiento (Ola 2)**: reactiva la reserva (`payment_timeout`) si la salida sigue abierta y hay cupo; si no, o si una persona la canceló, reembolsa solo y avisa al staff. Confirmar con negocio si el staff prefiere decidir caso a caso en vez de reembolso automático.
- [x] **Reembolsos (Ola 2)**: `createRefund`, `listRefunds`, `completeRefund` (operación nueva, para pagos manuales). `RefundSweeper` ejecuta cada `REFUND_SWEEP_SECONDS` (60) los `Refund` en `PENDING` que dejan la cancelación y la reprogramación: el cliente espera hasta un minuto; si se quiere inmediato, llamar a `RefundsExecutor.execute` desde `BookingLifecycleService` tras cancelar (no se tocó ese archivo para no pisar a API-A). El tope del operador cuenta lo ya devuelto de toda la reserva más lo pendiente.
- [ ] **Reembolsos de pagos manuales**: quedan `PENDING` hasta que el staff los confirme con `completeRefund`; falta una vista en el backoffice y un aviso cuando hay pendientes de más de N días.
- [x] **Comprobantes (Ola 2)**: `issueDocument`, `listDocuments`, `getDocument`, `retryDocument`, `voidDocument`, `createCreditNote`, `downloadDocumentFile`, cliente de `desertica-billing` (HTTP y simulado), cola en la base, almacenamiento local, nota de crédito automática al reembolsar y `PublicBooking.documents` con enlace firmado (`downloadPublicDocumentPdf`). Probado contra un servidor HTTP que valida `billing.yaml`; **no contra `desertica-billing` real ni SUNAT beta**.
- [x] **Empresa y series**: `getCompany`/`saveCompany`/`listSeries`/`createSeries` ya existen (API-A). Hay que cargar la `Company` y las series (`B001`, `F001`, y de notas de crédito `BC01`, `FC01`: la letra inicial debe coincidir con el comprobante afectado) desde el backoffice. Sin ellas la emisión responde 409 y avisa al staff.
- [ ] **Almacenamiento de comprobantes**: hoy un directorio local (`DOCUMENT_STORAGE_DIR`, fuera de Git); falta el adaptador S3 compatible, retención legal y respaldo.
- [ ] **Contador (comprobantes)**: tratamiento de depósito y saldo (hoy un comprobante por pago, con «Anticipo: » en el ítem del depósito); fuente y regla del tipo de cambio (`EXCHANGE_RATE_FALLBACK=3.7500` no es oficial; se espera `Setting.exchangeRates` por fecha); motivos de nota de crédito (hoy `06` devolución total y `09` disminución en el valor); si billing enviará boletas una a una o por resumen (`BILLING_SUBMISSION`).
- [ ] **Emisión de pagos manuales**: la recoge el barrido del worker (hasta `DOCUMENT_WORKER_SECONDS`, 15 s); si se quiere inmediata, llamar a `DocumentsService.autoIssueForPayment` desde `BookingPaymentsService.recordManual`.
- [x] **Pagos y disputas**: `listPayments`, `getPayment`, `listDisputes`, `getDispute`, `updateDispute`, `downloadDisputeEvidence` (ZIP con confirmación, políticas aceptadas con su texto, descargos, manifiesto, pagos, comprobantes y auditoría).
- [ ] **Evidencia de disputas**: el descargo no guarda el texto firmado ni un PDF (ver «Texto del descargo»); el paquete solo trae quién firmó, cuándo y desde qué IP. Enviar la evidencia a Stripe/Culqi sigue siendo manual.
- [ ] **Culqi sin verificar contra su documentación** (el entorno no llegó a docs.culqi.com): señal de 3DS pendiente (`action_code: REVIEW`) y campo `authentication_3DS` del reintento, esquema de firma del webhook (hoy HMAC-SHA256 del cuerpo en `x-culqi-signature`, con `CULQI_WEBHOOK_SECRET`), valores de `reason` en reembolsos, tipo del monto (texto o número), eventos de contracargo (hoy solo se abre una disputa si el cargo trae `dispute: true`). Revisar `modules/payments/providers/culqi.gateway.ts` con una clave de prueba y ajustar.
- [ ] **Pagos de prueba con claves reales**: crear un intent y un cargo de prueba, confirmar Apple Pay/Google Pay con el Express Checkout Element y registrar los webhooks (ver el informe de la Ola 2).
- [ ] **Alertas al staff**: `StaffAlertsService` escribe en el log y envía la plantilla `payment_staff_alert` a `STAFF_NOTIFY_EMAIL`; falta la plantilla real y un canal que no sea correo (WhatsApp o Slack).
- [ ] **Webhooks fuera de orden**: un reembolso o una disputa que llega antes de acreditarse el cobro responde 409 y depende de que la pasarela reenvíe (Stripe reintenta durante días); si pasa de ese plazo hay que reconciliar a mano.
- [ ] **Reembolso de Culqi con respuesta perdida**: si la llamada se agota, el API consulta el cargo (`amount_refunded`) antes de reintentar; si no puede confirmar, deja el reembolso en `FAILED` y avisa (el staff revisa el panel de Culqi). Revisar cuando se verifique la API.
- [x] **Administración**: `getCompany`/`saveCompany`, `listSeries`/`createSeries`, bloqueos (`listBlockedIdentities`, `createBlockedIdentity`, nuevo `deleteBlockedIdentity`; se aplican a bloqueos de cupo, reservas web y reclamos), `getDashboardSummary`, `getSalesReport` (json y csv), `eraseCustomer` y `cancelDeparture`.
- [ ] **Reclamos y bloqueos**: un reclamo de una IP o correo bloqueado se rechaza con 403, como pidió el encargo. El Libro de Reclamaciones debe estar siempre disponible para el consumidor: confirmar con el abogado si el bloqueo debe valer allí (la alternativa es recibir el reclamo y solo marcarlo).
- [ ] **ARCO**: `eraseCustomer` conserva comprobantes (con el receptor) y reclamos por obligación legal y se niega (409) si hay reservas vigentes de salidas futuras, reembolsos pendientes o disputas abiertas. Confirmar con el abogado los plazos de conservación de los reclamos y de los descargos firmados (hoy se anonimiza nombre, documento, notas médicas e IP, y se conserva la firma con su fecha y versión). Pendiente cuando exista almacenamiento: borrar los archivos PDF de descargos (hoy solo se limpia `pdfKey`). Se anonimiza por id: otro cliente con el mismo correo y distinto nombre es otra fila que hay que pedir por separado. La auditoría de reservas y clientes guarda solo nombres de campos (se corrigió `booking.update`, que guardaba notas y receptor).
- [x] **Cancelar desde "mi reserva"**: decidido para v2 (ver arriba).
- [ ] **`cancelDeparture` con `CLIENT_CHOICE`**: deja las reservas y avisa por correo, pero el cliente no puede elegir desde la web: el staff resuelve cada una con `cancelBooking` (reembolso completo exige `bookings:override`) o `rescheduleBooking`. Definir si el operador puede reembolsar el 100 % en estos casos.
- [x] **Mensajes de contacto**: `listContactMessages` y `updateContactMessage` (permisos `customers:read`/`customers:write`).
- [x] **Correo real**: `SmtpMailer` (nodemailer) y las plantillas `booking_created`, `booking_confirmed`, `booking_cancelled`, `booking_rescheduled`, `booking_expired`, `booking_access`, `payment_link`, `complaint_received`, `complaint_answered`, `complaint_staff_alert`, `contact_message` y la nueva `departure_cancelled`, en español e inglés. Falta: configurar `MAIL_DRIVER=smtp` y `SMTP_*` en staging y producción (autorizar la IP en el relay de Google Workspace, SPF/DKIM/DMARC del dominio), que el abogado revise los textos legales de `complaint_received` y que el dueño del negocio revise el tono. Los avisos de `departure_cancelled` y `booking_rescheduled` llevan `reason` en texto libre del staff.
- [ ] **Rutas de los enlaces de correo**: el API arma `/booking/<ref>?token=`, `/waiver/<token>` y `/pay/<token>` sobre `PUBLIC_WEB_URL` (`modules/bookings/links.ts`). `desertica-web` debe implementarlas o avisar para cambiarlas. La página del descargo debe mostrar `body` de `getWaiverForm` (el texto fijado), no el del CMS.
- [ ] **Redis en producción**: el rate limit y la caché del CMS usan memoria si no hay `REDIS_URL`; con más de una instancia hay que configurarlo. `BackgroundQueue` también es de una sola instancia y en memoria (solo la usa "mi reserva").
- [ ] **Turnstile**: sin `TURNSTILE_SECRET_KEY` no se verifica el captcha. Configurarlo en staging y producción.
- [ ] **Depósito**: el porcentaje vive en `Setting.depositPercent` (30 %); el CMS tiene `booking-setting.depositRate`. Dejar una sola fuente (el dinero es del API) y quitar el otro.
- [x] **Texto del descargo**: tipo `WAIVER` en `LegalDocument` (por tour e idioma) con snapshot de `tour.waiverBody`; `Waiver.version` y `legalDocumentId` apuntan a esa versión. **Paso manual antes de vender**: publicar el descargo de cada tour que lo exige (`POST /legal-documents`) o su reserva responde 409. Falta generar el PDF firmado a partir del snapshot.
- [ ] **Política de cancelación**: un tour sin política asignada se reserva con "sin reembolso" (`tiers: []`). Asignar una a todos los tours antes de vender; considerar exigirla en la publicación.
- [ ] **Reclamos**: el plazo se cuenta en días hábiles (lunes a viernes, sin feriados) con `complaintDueDays` = 15. Confirmar con el abogado si son 15 hábiles o 30 corridos y cargar los feriados.
- [x] **Bloqueos de cupo**: además del tope por IP (8 cada 15 minutos) y el captcha, una salida admite como máximo `maxActiveHoldsPerDeparture` bloqueos vigentes sin reserva (**10 por defecto**, ajustable en `/settings`); pasado el tope `createHold` responde 429 con `TOO_MANY_HOLDS`. Un atacante con muchas IP todavía puede retener hasta 10 bloqueos de hasta 20 asientos; la web debe tratar ese 429 como "intenta en unos minutos". Un tope por asientos retenidos queda para cuando haya datos de uso real.
- [x] **"Mi reserva"**: la búsqueda y el envío van a una cola (`BackgroundQueue`), así que la respuesta tarda lo mismo exista o no la reserva.
- [x] **IP del cliente**: `TRUST_PROXY` (0 a 10) fija los saltos confiables de `X-Forwarded-For`; con 0 en producción el API avisa al arrancar. **Verificar en staging** el número real de saltos (2 con Cloudflare y Coolify) y que `desertica-web` reenvía la IP del visitante en `X-Forwarded-For`.
- [ ] **Logs**: las rutas con token (`/public/waivers|payment-links|holds/<token>`) y los parámetros `token`/`key`/`secret` salen redactados; los errores de Prisma se registran sin su mensaje y los de SMTP sin correos. `LogMailer` imprime enlaces con tokens: por eso producción exige `MAIL_DRIVER=smtp`. Falta decidir la retención de logs.
- [ ] **Imagen Docker**: se verificó el `build` de Nest pero no `docker build` (no había daemon). La imagen incluye devDependencies porque el CLI de Prisma se usa para migrar.

## Documentación

- [ ] ADRs de las decisiones del plan.
- [x] `CLAUDE.md` de `desertica-api`, `desertica-backoffice` y `desertica-billing`.

## Entorno cloud (a configurar antes de las sesiones en paralelo)

- [ ] Permitir en la red del entorno los hosts de Stripe (test), Culqi (sandbox), SUNAT beta, Google, Meta y los registros de paquetes (Packagist, npm).
- [ ] Instalar PHP 8.3, Composer, Redis y Postgres en el script de configuración del entorno.
- [ ] Guardar las claves de prueba como secretos del entorno. El certificado digital y la clave SOL reales no van a cloud.
- [x] Crear los repos `desertica-backoffice` y `desertica-billing` y añadirlos a las sesiones.
