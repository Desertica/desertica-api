import { Injectable, Logger } from '@nestjs/common';
import { requestLocale } from '../../common/request-context';
import { CmsClient } from './cms.client';

/**
 * Títulos de tour para las respuestas. El texto editorial vive en el CMS: aquí
 * solo se consulta (con caché) y, si el idioma pedido no tiene el título o el
 * CMS no responde, se cae al título en inglés que `TourRef` trae de la
 * sincronización.
 */
@Injectable()
export class TourTitlesService {
  private readonly logger = new Logger(TourTitlesService.name);

  constructor(private readonly cms: CmsClient) {}

  /**
   * `slug → título` en el idioma de la petición (`Accept-Language`) o el dado;
   * el título en inglés de `TourRef` es el respaldo.
   */
  async forTours(
    tours: { slug: string; title: string }[],
    locale: string = requestLocale(),
  ): Promise<Map<string, string>> {
    const titles = new Map(tours.map((t) => [t.slug, t.title]));
    if (locale === 'en' || tours.length === 0) return titles;
    try {
      for (const tour of await this.cms.listTours({ locale })) {
        if (titles.has(tour.slug) && tour.title) {
          titles.set(tour.slug, tour.title);
        }
      }
    } catch (error) {
      this.logger.warn(
        `No localized titles for "${locale}", using English: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return titles;
  }
}
