# Desertica API

Backend transaccional de Desertica (tours de desierto en Ica, Huacachina, Paracas y Nazca): reservas, disponibilidad, pagos, comprobantes y operación. NestJS 11, Prisma 7, PostgreSQL 16. Los clientes son `Desertica/desertica-web` (sitio público) y `Desertica/desertica-backoffice` (staff). La emisión de boletas y facturas la hace `Desertica/desertica-billing`. El contenido editorial (textos, medios) lo sirve `Desertica/desertica-cms`.

Lee `README.md` (setup), `openapi/openapi.yaml` (contrato) y `docs/PENDIENTES.md` (lo que no se está haciendo ahora).

## Commands

```bash
npm ci && cp .env.example .env     # una vez
bash scripts/cloud-start.sh        # sesiones cloud: levanta Postgres, migra y arranca el API
npm run db:up                      # local con Docker
npx prisma migrate dev             # tras cambiar prisma/schema.prisma
npm run start:dev                  # http://localhost:3000/api, Swagger en /docs
npm run lint && npm test && npm run test:e2e && npm run build
npm run openapi:lint               # valida openapi/openapi.yaml y openapi/billing.yaml
```

Usa **Node 22**.

## Rules

- **Contrato primero.** Un cambio de comportamiento o de forma empieza en `openapi/openapi.yaml` (o `openapi/billing.yaml`) y se implementa después. El `operationId` es el nombre del método del cliente generado: no se renombra uno existente sin avisar a web y backoffice.
- **Clientes del contrato**: no se publica un paquete. `desertica-web` y `desertica-backoffice` generan sus tipos con `openapi-typescript` (y llaman con `openapi-fetch`) a partir de `openapi/openapi.yaml` de este repo, clonado al lado (`../desertica-api`), y commitean el resultado. `desertica-billing` implementa `openapi/billing.yaml`. Verificado: ambos archivos generan TypeScript válido con `openapi-typescript@7`.
- **Dinero**: enteros en la unidad menor (`*Cents`), siempre con IGV incluido. El precio es único para todos los clientes; no hay precio ni exoneración por nacionalidad. Monedas `USD` y `PEN`. Stripe cobra solo USD; Culqi cobra USD o PEN.
- **Fuentes de verdad**: el contenido editorial vive en el CMS y aquí solo hay `TourRef` (slug y ajustes operativos); dinero, cupos, reservas y comprobantes viven aquí. No dupliques títulos ni textos de tours.
- **Series y correlativos** (`Series.nextNumber`) son del API. `desertica-billing` recibe serie y número ya asignados.
- **Secretos fiscales**: el certificado digital y la clave SOL no existen en este repo ni en este API; viven solo en `desertica-billing`.
- **Pagos**: el estado de un pago lo fija el webhook de la pasarela, nunca el navegador. Los webhooks se validan por firma y se guardan en `WebhookEvent` (idempotentes por `provider` y `eventId`). Todo lo que mueve dinero detrás de la interfaz `PaymentProvider` (adaptadores `stripe` y `culqi`). Nunca se maneja el número de tarjeta.
- **Cupos**: crear un bloqueo (`Hold`) y una reserva descuenta cupo dentro de una transacción; dos peticiones simultáneas sobre el último cupo no pueden ganar las dos.
- **Auditoría**: los cambios de estado y los movimientos de dinero escriben en `AuditLog` (solo inserción).
- Zona horaria de negocio `America/Lima`; en base de datos todo en UTC.
- `Tour` en `prisma/schema.prisma` y `src/modules/tours` son obsoletos y se eliminan cuando exista el catálogo sobre `TourRef`. No agregues usos nuevos.
- Nunca commitees `.env`.

## Pitfalls

- `prisma generate` corre en `postinstall`; el cliente generado (`src/generated/prisma`) no se versiona.
- Los endpoints públicos (`/public/*`) son anónimos: validan con DTOs estrictos, limitan por IP y por correo y aceptan `Idempotency-Key` donde crean reservas o pagos.
- El rate limit en memoria no sirve con varias instancias; usa Redis.
