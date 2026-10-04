import {
  addDays,
  limaDate,
  limaMonthRange,
  limaStartOfDay,
  limaWeekday,
} from './lima';

describe('Lima time helpers', () => {
  it('gives the local date, not the UTC one', () => {
    // 02:00 UTC del 5 de octubre aún es 4 de octubre, 21:00 en Lima.
    expect(limaDate(new Date('2026-10-05T02:00:00Z'))).toBe('2026-10-04');
    expect(limaDate(new Date('2026-10-05T05:00:00Z'))).toBe('2026-10-05');
  });

  it('gives the local weekday', () => {
    // 2026-10-04 es domingo.
    expect(limaWeekday(new Date('2026-10-05T02:00:00Z'))).toBe(0);
    expect(limaWeekday(new Date('2026-10-05T05:00:00Z'))).toBe(1);
  });

  it('computes start of day and month ranges in UTC', () => {
    expect(limaStartOfDay('2026-10-04').toISOString()).toBe(
      '2026-10-04T05:00:00.000Z',
    );
    const range = limaMonthRange('2026-12');
    expect(range.from.toISOString()).toBe('2026-12-01T05:00:00.000Z');
    expect(range.to.toISOString()).toBe('2027-01-01T05:00:00.000Z');
  });

  it('adds days across month boundaries', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });
});
