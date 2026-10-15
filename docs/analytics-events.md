# Eventos de analítica

Contrato entre `desertica-web` (navegador), `desertica-api` (servidor) y Google Tag Manager. La web publica estos eventos en `window.dataLayer`; GTM los envía a GA4 y a Meta. Un cambio en nombres o parámetros se hace aquí primero.

## Reglas

- **Ninguna etiqueta de analítica o marketing se dispara sin consentimiento.** El banner de cookies usa Consent Mode v2 con todo denegado por defecto; GTM solo dispara las etiquetas de una categoría cuando esa categoría está concedida.
- Los eventos se emiten solo en el navegador (nunca durante el render en el servidor).
- **Importes**: unidades mayores con decimales (`123.5`), no centavos, y con IGV incluido, porque así los espera GA4 y Meta. Moneda en `currency` (`USD` o `PEN`).
- **Ítem**: `item_id` es el slug del tour, `item_name` su título en el idioma de la página, `item_category` el destino y `item_variant` el formato (`SHARED` o `PRIVATE`).
- **Deduplicación**: cada evento de compra lleva `event_id` (la referencia de la reserva). El API envía el mismo `event_id` por servidor cuando existe consentimiento, para que GA4 y Meta no cuenten dos veces.
- El backoffice no usa analítica de marketing.

## Eventos

| Evento (GA4) | Evento (Meta) | Cuándo | Parámetros |
|---|---|---|---|
| `view_item_list` | — | Listado de tours | `item_list_name`, `items[]` |
| `select_item` | — | Clic en un tour del listado | `item_list_name`, `items[]` |
| `view_item` | `ViewContent` | Detalle de un tour | `currency`, `value`, `items[]` |
| `begin_checkout` | `InitiateCheckout` | El cliente confirma fecha y personas y crea la reserva | `currency`, `value`, `items[]`, `event_id` |
| `add_payment_info` | `AddPaymentInfo` | El cliente elige método de pago | `currency`, `value`, `payment_type` (`stripe` o `culqi`), `event_id` |
| `purchase` | `Purchase` | El pago queda confirmado | `transaction_id` (referencia), `currency`, `value`, `items[]`, `event_id` |
| `generate_lead` | `Lead` | Envío del formulario de contacto | `form` (`contact`) |
| `click_whatsapp` | `Contact` | Clic en un enlace de WhatsApp | `placement` |
| `cancel_booking` | — | Reserva cancelada desde "mi reserva" | `transaction_id` |

`value` en `purchase` es lo realmente cobrado en esa operación: en un depósito, el monto del depósito; en el saldo posterior, el saldo.

## Atribución

En la primera visita la web guarda `utm_source`, `utm_medium`, `utm_campaign`, `utm_content`, `utm_term`, `gclid`, `fbclid`, la ruta de entrada y el referrer (solo con consentimiento de marketing), y los envía en `attribution` al crear la reserva. El API los guarda en `Booking.attribution`.

## Eventos desde el servidor (v2)

`Purchase` por la Conversions API de Meta y `purchase` por el Measurement Protocol de GA4, enviados por el API al confirmar el pago, con el mismo `event_id` y solo con consentimiento de marketing registrado. Los datos personales se envían con hash SHA-256. Está en `docs/PENDIENTES.md`.
