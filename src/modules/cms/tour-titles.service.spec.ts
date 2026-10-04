import { CmsClient } from './cms.client';
import { pickLocale } from '../../common/locale';
import { TourTitlesService } from './tour-titles.service';

describe('pickLocale', () => {
  it.each([
    [undefined, 'en'],
    ['', 'en'],
    ['es', 'es'],
    ['es-PE,es;q=0.9,en;q=0.8', 'es'],
    ['fr-FR,fr;q=0.9,en;q=0.5', 'en'],
    ['en;q=0.4, es;q=0.9', 'es'],
    ['de, ES;q=0.2', 'es'],
    ['es;q=0', 'en'],
    ['*', 'en'],
  ])('%j -> %s', (header, expected) => {
    expect(pickLocale(header)).toBe(expected);
  });
});

describe('TourTitlesService', () => {
  const tours = [
    { slug: 'dune-buggy', title: 'Dune buggy' },
    { slug: 'sandboard', title: 'Sandboard' },
  ];

  it('returns the English titles without calling the CMS', async () => {
    const listTours = jest.fn();
    const service = new TourTitlesService({
      listTours,
    } as unknown as CmsClient);
    const titles = await service.forTours(tours, 'en');
    expect(titles.get('dune-buggy')).toBe('Dune buggy');
    expect(listTours).not.toHaveBeenCalled();
  });

  it('uses the localized title and falls back per slug', async () => {
    const listTours = jest
      .fn()
      .mockResolvedValue([
        { slug: 'dune-buggy', title: 'Buggy en las dunas', durationHours: 2 },
      ]);
    const service = new TourTitlesService({
      listTours,
    } as unknown as CmsClient);
    const titles = await service.forTours(tours, 'es');
    expect(listTours).toHaveBeenCalledWith({ locale: 'es' });
    expect(titles.get('dune-buggy')).toBe('Buggy en las dunas');
    expect(titles.get('sandboard')).toBe('Sandboard');
  });

  it('falls back to English when the CMS fails', async () => {
    const listTours = jest.fn().mockRejectedValue(new Error('down'));
    const service = new TourTitlesService({
      listTours,
    } as unknown as CmsClient);
    const titles = await service.forTours(tours, 'es');
    expect(titles.get('sandboard')).toBe('Sandboard');
  });
});
