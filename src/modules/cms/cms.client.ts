import {
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EnvVars } from '../../config/env.validation';
import {
  KEY_VALUE_STORE,
  type KeyValueStore,
} from '../../common/cache/key-value-store';

/**
 * Tour tal como lo necesita el API: slug y título. Los datos operativos ya son del API
 * (`TourRef`); mientras el CMS los conserve se traen solo para la importación única del sync.
 */
export interface CmsTour {
  slug: string;
  title: string;
  durationHours?: number | null;
  format?: 'SHARED' | 'PRIVATE' | 'BOTH' | null;
  languages?: string[];
  /** Punto de encuentro en el idioma pedido. */
  meeting?: string | null;
  meetingPointUrl?: string | null;
  latitude?: number | null;
  longitude?: number | null;
}

/** Campos operativos que el CMS está retirando; Strapi 5 responde 400 si se pide uno que ya no existe. */
const LEGACY_TOUR_FIELDS = [
  'durationHours',
  'format',
  'languages',
  'meeting',
  'meetingPointUrl',
  'latitude',
  'longitude',
];

const tourFields = (names: string[]) =>
  names.map((name, i) => `&fields[${i}]=${name}`).join('');

/** Número dentro de un rango (Strapi puede devolver los decimales como texto) o `null`. */
const numberIn = (value: unknown, min: number, max: number): number | null => {
  const n =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim()
        ? Number(value)
        : NaN;
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
};

const textUpTo = (value: unknown, max: number): string | null =>
  typeof value === 'string' && value.trim() && value.trim().length <= max
    ? value.trim()
    : null;

/** Página del CMS (documentos legales). `body` es Markdown. */
export interface CmsPage {
  slug: string;
  title: string;
  body: string;
}

/** Descargo de responsabilidad de un tour (`tour.waiverBody`, Markdown, localizado). */
export interface CmsTourWaiver {
  slug: string;
  /** Título del tour en el idioma pedido. */
  title: string;
  /** `null` si el tour no define descargo en ese idioma. */
  waiverBody: string | null;
}

class CmsHttpError extends Error {
  constructor(readonly status: number) {
    super(`CMS responded ${status}`);
  }
}

/**
 * Cliente de solo lectura del CMS (Strapi 5). Ver `CONTRACT.md` en
 * `Desertica/desertica-cms`. Las respuestas se cachean en `KeyValueStore`;
 * si el CMS falla se sirve la última respuesta buena.
 */
@Injectable()
export class CmsClient {
  private readonly logger = new Logger(CmsClient.name);

  constructor(
    private readonly config: ConfigService<EnvVars, true>,
    @Inject(KEY_VALUE_STORE) private readonly store: KeyValueStore,
  ) {}

  /** Tours publicados (por defecto en inglés, el idioma por defecto del CMS). */
  async listTours(
    options: { fresh?: boolean; locale?: string } = {},
  ): Promise<CmsTour[]> {
    const locale = options.locale ?? 'en';
    const base = `/api/tours?locale=${encodeURIComponent(locale)}&pagination[pageSize]=100&sort=order:asc`;
    const rows = await this.cached(
      locale === 'en' ? 'tours' : `tours:${locale}`,
      base + tourFields(['slug', 'title', ...LEGACY_TOUR_FIELDS]),
      options.fresh,
      // Cuando el CMS ya no tiene los campos operativos, se pide solo lo que sigue siendo suyo.
      base + tourFields(['slug', 'title']),
    );
    return rows.flatMap((row) => {
      const slug = row.slug;
      if (typeof slug !== 'string' || !slug) return [];
      const format =
        typeof row.format === 'string' ? row.format.toUpperCase() : null;
      const duration = numberIn(row.durationHours, 1, 240);
      const url = textUpTo(row.meetingPointUrl, 500);
      return [
        {
          slug,
          title: typeof row.title === 'string' ? row.title : slug,
          durationHours: duration === null ? null : Math.round(duration),
          format:
            format === 'SHARED' || format === 'PRIVATE' || format === 'BOTH'
              ? format
              : null,
          languages: Array.isArray(row.languages)
            ? row.languages
                .flatMap((l) =>
                  typeof l === 'string' && /^[a-z]{2}$/i.test(l)
                    ? [l.toLowerCase()]
                    : [],
                )
                .slice(0, 10)
            : [],
          meeting: textUpTo(row.meeting, 2000),
          meetingPointUrl: url && /^https?:\/\/\S+$/.test(url) ? url : null,
          latitude: numberIn(row.latitude, -90, 90),
          longitude: numberIn(row.longitude, -180, 180),
        },
      ];
    });
  }

  /** Página por slug y locale; `null` si no existe en ese idioma. */
  async getPage(slug: string, locale: string): Promise<CmsPage | null> {
    const rows = await this.cached(
      `page:${locale}:${slug}`,
      `/api/pages?locale=${encodeURIComponent(locale)}&filters[slug][$eq]=${encodeURIComponent(slug)}&fields[0]=slug&fields[1]=title&fields[2]=body`,
      true,
    );
    const row = rows[0];
    if (!row || typeof row.body !== 'string') return null;
    return {
      slug,
      title: typeof row.title === 'string' ? row.title : slug,
      body: row.body,
    };
  }

  /**
   * Título y descargo de un tour en un idioma; `null` si el tour no existe en
   * el CMS (o no está publicado) en ese idioma. Siempre fresco: es lo que se
   * congela como evidencia.
   */
  async getTourWaiver(
    slug: string,
    locale: string,
  ): Promise<CmsTourWaiver | null> {
    const rows = await this.cached(
      `tour-waiver:${locale}:${slug}`,
      `/api/tours?locale=${encodeURIComponent(locale)}&filters[slug][$eq]=${encodeURIComponent(slug)}&fields[0]=slug&fields[1]=title&fields[2]=waiverBody`,
      true,
    );
    const row = rows[0];
    if (!row) return null;
    return {
      slug,
      title: typeof row.title === 'string' ? row.title : slug,
      waiverBody:
        typeof row.waiverBody === 'string' && row.waiverBody.trim()
          ? row.waiverBody
          : null,
    };
  }

  private async cached(
    name: string,
    path: string,
    fresh = false,
    /** Ruta a la que se reintenta si el CMS responde 400 (campo desconocido). */
    pathOn400?: string,
  ): Promise<Record<string, unknown>[]> {
    const key = `cms:${name}`;
    const ttlMs =
      this.config.get('CMS_CACHE_TTL_SECONDS', { infer: true }) * 1000;
    if (!fresh && ttlMs > 0) {
      const hit = await this.store.get(key);
      if (hit) return JSON.parse(hit) as Record<string, unknown>[];
    }
    try {
      const rows = await this.fetchData(path).catch((error) =>
        pathOn400 && error instanceof CmsHttpError && error.status === 400
          ? this.fetchData(pathOn400)
          : Promise.reject(error as Error),
      );
      const payload = JSON.stringify(rows);
      if (ttlMs > 0) await this.store.set(key, payload, ttlMs);
      await this.store.set(`${key}:last-good`, payload);
      return rows;
    } catch (error) {
      const stale = await this.store.get(`${key}:last-good`);
      if (stale) {
        this.logger.warn(`CMS unavailable, serving last good ${name}`);
        return JSON.parse(stale) as Record<string, unknown>[];
      }
      this.logger.error(
        `CMS request failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw new ServiceUnavailableException('CMS unavailable');
    }
  }

  private async fetchData(path: string): Promise<Record<string, unknown>[]> {
    const base = this.config
      .get('CMS_URL', { infer: true })
      .replace(/\/+$/, '');
    const token = this.config.get('CMS_API_TOKEN', { infer: true });
    const response = await fetch(`${base}${path}`, {
      headers: {
        Accept: 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new CmsHttpError(response.status);
    const body = (await response.json()) as { data?: unknown };
    if (!Array.isArray(body.data)) throw new Error('Unexpected CMS payload');
    return body.data as Record<string, unknown>[];
  }
}
