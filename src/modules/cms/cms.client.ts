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

/** Tour tal como lo necesita el API: solo slug y datos operativos. */
export interface CmsTour {
  slug: string;
  title: string;
  durationHours: number | null;
}

/** Página del CMS (documentos legales). `body` es Markdown. */
export interface CmsPage {
  slug: string;
  title: string;
  body: string;
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

  /** Tours publicados (título en inglés, el idioma por defecto del CMS). */
  async listTours(options: { fresh?: boolean } = {}): Promise<CmsTour[]> {
    const rows = await this.cached(
      'tours',
      '/api/tours?locale=en&pagination[pageSize]=100&fields[0]=slug&fields[1]=title&fields[2]=durationHours&sort=order:asc',
      options.fresh,
    );
    return rows.flatMap((row) => {
      const slug = row.slug;
      if (typeof slug !== 'string' || !slug) return [];
      return [
        {
          slug,
          title: typeof row.title === 'string' ? row.title : slug,
          durationHours:
            typeof row.durationHours === 'number'
              ? Math.round(row.durationHours)
              : null,
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

  private async cached(
    name: string,
    path: string,
    fresh = false,
  ): Promise<Record<string, unknown>[]> {
    const key = `cms:${name}`;
    const ttlMs =
      this.config.get('CMS_CACHE_TTL_SECONDS', { infer: true }) * 1000;
    if (!fresh && ttlMs > 0) {
      const hit = await this.store.get(key);
      if (hit) return JSON.parse(hit) as Record<string, unknown>[];
    }
    try {
      const rows = await this.fetchData(path);
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
    if (!response.ok) throw new Error(`CMS responded ${response.status}`);
    const body = (await response.json()) as { data?: unknown };
    if (!Array.isArray(body.data)) throw new Error('Unexpected CMS payload');
    return body.data as Record<string, unknown>[];
  }
}
