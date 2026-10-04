import { csvCell, limaRange, toCsv } from './reports.service';

describe('csvCell', () => {
  it.each([
    ['plain', 'plain'],
    ['=SUM(A1)', "'=SUM(A1)"],
    ['+1', "'+1"],
    ['-1', "'-1"],
    ['@cmd', "'@cmd"],
    ['\tTab', "'\tTab"],
    ['\rReturn', `"'\rReturn"`],
    ['a,b', '"a,b"'],
    ['say "hi"', '"say ""hi"""'],
    ['=a,b', `"'=a,b"`],
  ])('%j -> %j', (input, expected) => {
    expect(csvCell(input)).toBe(expected);
  });

  it('does not touch numbers, even negative ones are text-prefixed only when they are strings', () => {
    expect(csvCell(1200)).toBe('1200');
    expect(csvCell(-5)).toBe("'-5");
  });
});

describe('toCsv', () => {
  it('writes a header and CRLF rows', () => {
    expect(
      toCsv([
        {
          key: '2026-01-01',
          currency: 'USD',
          grossCents: 100,
          refundedCents: 0,
          bookings: 1,
        },
      ]),
    ).toBe(
      'key,currency,grossCents,refundedCents,bookings\r\n2026-01-01,USD,100,0,1\r\n',
    );
  });
});

describe('limaRange', () => {
  it('spans from 00:00 Lima of the first day to 00:00 Lima after the last', () => {
    const { start, end } = limaRange('2026-03-01', '2026-03-02');
    expect(start.toISOString()).toBe('2026-03-01T05:00:00.000Z');
    expect(end.toISOString()).toBe('2026-03-03T05:00:00.000Z');
  });

  it('rejects invalid, reversed and over-long ranges', () => {
    expect(() => limaRange('2026-02-30', '2026-03-01')).toThrow();
    expect(() => limaRange('2026-03-02', '2026-03-01')).toThrow();
    expect(() => limaRange('2025-01-01', '2026-03-01')).toThrow();
    expect(() => limaRange('2026-01-01', '2026-12-31')).not.toThrow();
  });
});
