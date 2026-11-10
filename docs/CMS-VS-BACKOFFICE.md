# Qué vive en el CMS y qué en el backoffice

Decidido el 2026-11-10. Regla: **cada dato tiene un solo dueño**, y el dueño es el sistema donde un error tiene consecuencias. Si un dato equivocado cobra mal, vende un cupo que no existe o deja sin prueba legal, vive en el backoffice (API). Si solo se ve mal, vive en el CMS.

## El CMS (Strapi)

Lo que se lee y vende: nombre y descripción del tour, itinerario, fotos y video, qué incluye y qué llevar, preguntas frecuentes, SEO, textos de la web, menús, colores, blog, contenido de la tienda y canales de contacto (correo, teléfonos, WhatsApp, redes).

## El backoffice (API)

Precios, salidas, cupos, bloqueos de fechas, reglas de reserva, políticas de cancelación, documentos legales, datos fiscales, series de comprobantes, reservas, clientes, pagos, reembolsos, mensajes de contacto, reclamos y usuarios del personal.

## Cómo se unen

El tour nace en el CMS con su contenido y su slug. El backoffice lo sincroniza (`POST /tour-refs/sync`), le pone precio, salidas y reglas, y lo activa para vender. La web junta las dos fuentes en la ficha.

## Lo que hay que mover (en este orden)

1. **Documentos legales y política de cancelación.** Hoy el texto se escribe en el CMS y el backoffice lo copia al publicar; la página `/terms` muestra el CMS y el cliente acepta la copia, que pueden no coincidir. Destino: se escriben, versionan y publican solo en el backoffice; la web muestra la versión vigente del API (`/public/legal-documents/current`). El texto de la política de cancelación sale de las mismas reglas que usa el API para reembolsar. Incluye el descargo de cada tour (`tour.waiverBody` deja de existir en el CMS).
2. **Precios.** Fuera del CMS `priceFrom` y `pricePen`; la tarjeta y la ficha leen el "desde" del API. Ver "Precios y horarios" en `PENDIENTES.md`.
3. **Reglas de reserva.** Meses del calendario, mínimos y máximo de personas y depósito salen de `booking-setting` del CMS y pasan al API, que es quien las hace cumplir.
4. **Identidad fiscal.** RUC, razón social y domicilio fiscal solo en el backoffice; la web los lee de `/public/company` para el pie. Los canales de contacto siguen en el CMS.
5. **Datos operativos del tour.** Duración, formato, idiomas, punto de encuentro, capacidad, edad y altura mínimas: dueño el backoffice; el CMS deja de tener esos campos.

Cada punto toca API (contrato primero en `openapi/openapi.yaml`), backoffice, web y CMS, y se hace en su propio PR por repo.
