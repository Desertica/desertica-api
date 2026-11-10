import { cheapestBySlug } from './prices.service';

const rule = (
  slug: string,
  unit: 'PER_PERSON' | 'PER_GROUP',
  adultCents: number,
  groupCents: number | null = null,
) => ({
  unit,
  adultCents,
  groupCents,
  tourRef: { slug },
});

describe('cheapestBySlug', () => {
  it('keeps the cheapest per-person price of each tour', () => {
    expect(
      cheapestBySlug([
        rule('dune', 'PER_PERSON', 4500),
        rule('dune', 'PER_PERSON', 3900),
        rule('oasis', 'PER_PERSON', 9000),
      ]),
    ).toEqual([
      { slug: 'dune', fromCents: 3900, unit: 'PER_PERSON' },
      { slug: 'oasis', fromCents: 9000, unit: 'PER_PERSON' },
    ]);
  });

  it('prefers a per-person price over a group one, and uses the group price when that is all there is', () => {
    expect(
      cheapestBySlug([
        rule('dune', 'PER_GROUP', 0, 20000),
        rule('dune', 'PER_PERSON', 4500),
        rule('private', 'PER_GROUP', 0, 30000),
        rule('private', 'PER_GROUP', 0, 25000),
      ]),
    ).toEqual([
      { slug: 'dune', fromCents: 4500, unit: 'PER_PERSON' },
      { slug: 'private', fromCents: 25000, unit: 'PER_GROUP' },
    ]);
  });
});
