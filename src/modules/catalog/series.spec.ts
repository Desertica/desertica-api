import { expandSeries } from './series';

describe('expandSeries', () => {
  // 2026-10-05 es lunes. 09:00 en Lima = 14:00 UTC.
  const first = new Date('2026-10-05T14:00:00Z');

  it('keeps the Lima hour and only the chosen weekdays', () => {
    const dates = expandSeries(first, '2026-10-18', [1, 3, 6]);
    expect(dates.map((d) => d.toISOString())).toEqual([
      '2026-10-05T14:00:00.000Z', // lun
      '2026-10-07T14:00:00.000Z', // mié
      '2026-10-10T14:00:00.000Z', // sáb
      '2026-10-12T14:00:00.000Z', // lun
      '2026-10-14T14:00:00.000Z', // mié
      '2026-10-17T14:00:00.000Z', // sáb
    ]);
  });

  it('includes the until date and starts only from the first date', () => {
    expect(expandSeries(first, '2026-10-05', [1])).toHaveLength(1);
    expect(expandSeries(first, '2026-10-05', [2])).toHaveLength(0);
    expect(expandSeries(first, '2026-10-04', [1])).toHaveLength(0);
  });

  it('uses the Lima weekday, not the UTC one', () => {
    // 22:00 Lima del lunes 5-oct = 03:00 UTC del martes 6-oct.
    const late = new Date('2026-10-06T03:00:00Z');
    expect(expandSeries(late, '2026-10-05', [1])).toHaveLength(1);
    expect(expandSeries(late, '2026-10-05', [2])).toHaveLength(0);
  });
});
