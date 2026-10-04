import { isBlackedOut, isOnSale, RuleLike, selectRule } from './pricing';

const rule = (over: Partial<RuleLike>): RuleLike => ({
  id: 'r',
  unit: 'PER_PERSON',
  adultCents: 1000,
  childCents: null,
  groupCents: null,
  minPeople: null,
  maxPeople: null,
  validFrom: null,
  validTo: null,
  priority: 0,
  createdAt: new Date('2026-01-01'),
  ...over,
});

describe('selectRule', () => {
  const dep = new Date('2026-10-10T14:00:00Z'); // 09:00 Lima, 10-oct

  it('picks the highest priority, then the newest', () => {
    const rules = [
      rule({ id: 'low', priority: 0 }),
      rule({ id: 'high', priority: 5 }),
      rule({ id: 'high-new', priority: 5, createdAt: new Date('2026-02-01') }),
    ];
    expect(selectRule(rules, dep)?.id).toBe('high-new');
  });

  it('honours validity by Lima date, inclusive on both ends', () => {
    const r = rule({
      validFrom: new Date('2026-10-10'),
      validTo: new Date('2026-10-10'),
    });
    expect(selectRule([r], dep)).toBe(r);
    // 03:00 UTC del 11-oct sigue siendo 10-oct en Lima.
    expect(selectRule([r], new Date('2026-10-11T03:00:00Z'))).toBe(r);
    expect(selectRule([r], new Date('2026-10-11T06:00:00Z'))).toBeNull();
    expect(selectRule([r], new Date('2026-10-09T04:00:00Z'))).toBeNull();
  });

  it('filters by party size when known', () => {
    const small = rule({ id: 'small', maxPeople: 2, priority: 1 });
    const big = rule({ id: 'big', minPeople: 3 });
    expect(selectRule([small, big], dep, 2)?.id).toBe('small');
    expect(selectRule([small, big], dep, 5)?.id).toBe('big');
    expect(selectRule([small, big], dep)?.id).toBe('small');
  });

  it('returns null with no rules', () => {
    expect(selectRule([], dep)).toBeNull();
  });
});

describe('isBlackedOut', () => {
  const blackouts = [
    {
      tourRefId: null,
      startsOn: new Date('2026-12-24'),
      endsOn: new Date('2026-12-26'),
    },
    {
      tourRefId: 't1',
      startsOn: new Date('2026-11-01'),
      endsOn: new Date('2026-11-01'),
    },
  ];
  it('applies global and per-tour blackouts by Lima date', () => {
    expect(
      isBlackedOut(blackouts, 't2', new Date('2026-12-25T15:00:00Z')),
    ).toBe(true);
    expect(
      isBlackedOut(blackouts, 't1', new Date('2026-11-01T15:00:00Z')),
    ).toBe(true);
    expect(
      isBlackedOut(blackouts, 't2', new Date('2026-11-01T15:00:00Z')),
    ).toBe(false);
    expect(
      isBlackedOut(blackouts, 't2', new Date('2026-12-27T04:00:00Z')),
    ).toBe(true); // 26-dic 23:00 Lima
    expect(
      isBlackedOut(blackouts, 't2', new Date('2026-12-27T05:00:00Z')),
    ).toBe(false);
  });
});

describe('isOnSale', () => {
  const now = new Date('2026-10-10T12:00:00Z');
  it('requires OPEN and now before the cutoff', () => {
    const base = {
      status: 'OPEN',
      startsAt: new Date('2026-10-10T14:00:00Z'),
      cutoffMinutes: 60,
    };
    expect(isOnSale(base, now)).toBe(true);
    expect(isOnSale({ ...base, cutoffMinutes: 120 }, now)).toBe(false);
    expect(isOnSale({ ...base, status: 'CLOSED' }, now)).toBe(false);
  });
});
