import { webUrl } from '../../common/web-links';

/**
 * Enlaces que se mandan por correo, con el idioma de la reserva (`es-PE` cuenta como `es`).
 * Las rutas las define `desertica-web`; si cambian allá, se ajustan solo aquí.
 */
const url = (base: string, locale: string, path: string) =>
  webUrl(base, locale.split('-')[0].toLowerCase(), path);

export const links = {
  booking: (base: string, locale: string, reference: string, token: string) =>
    url(
      base,
      locale,
      `booking/${encodeURIComponent(reference)}?token=${encodeURIComponent(token)}`,
    ),
  waiver: (base: string, locale: string, token: string) =>
    url(base, locale, `waiver/${encodeURIComponent(token)}`),
  payment: (base: string, locale: string, token: string) =>
    url(base, locale, `pay/${encodeURIComponent(token)}`),
};
