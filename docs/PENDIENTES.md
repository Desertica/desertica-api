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
- [ ] Contabilidad (standby): exportación CSV de ventas y pagos, reporte de conciliación con Stripe y Culqi, formato PLE y alerta de vencimiento del certificado.

## Producto: v2 (después de las primeras ventas)

- [ ] Evidencia de contracargos generada automáticamente.
- [ ] Conversions API de Meta y Measurement Protocol de GA4 desde el servidor.
- [ ] Lista de espera y códigos promocionales.
- [ ] WhatsApp Business API para confirmaciones.
- [ ] Sincronización con Google Calendar y manifiesto automático para guías; rol Guía.
- [ ] Cuentas de cliente con magic link, reseñas, búsqueda de DNI/RUC y canal ARCO automatizado.

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

## Documentación

- [ ] ADRs de las decisiones del plan.
- [x] `CLAUDE.md` de `desertica-api`, `desertica-backoffice` y `desertica-billing`.

## Entorno cloud (a configurar antes de las sesiones en paralelo)

- [ ] Permitir en la red del entorno los hosts de Stripe (test), Culqi (sandbox), SUNAT beta, Google, Meta y los registros de paquetes (Packagist, npm).
- [ ] Instalar PHP 8.3, Composer, Redis y Postgres en el script de configuración del entorno.
- [ ] Guardar las claves de prueba como secretos del entorno. El certificado digital y la clave SOL reales no van a cloud.
- [x] Crear los repos `desertica-backoffice` y `desertica-billing` y añadirlos a las sesiones.
