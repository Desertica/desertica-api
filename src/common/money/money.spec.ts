import {
  computeDeposit,
  computeRefund,
  MoneyError,
  pendingCents,
  percentOf,
  priceBooking,
  priceDifference,
  rateToBps,
  roundDiv,
  selectRefundTier,
  splitIgv,
} from './money';

describe('roundDiv', () => {
  it('rounds half up with integer math', () => {
    expect(roundDiv(5, 2)).toBe(3);
    expect(roundDiv(4, 3)).toBe(1);
    expect(roundDiv(5, 3)).toBe(2);
    expect(roundDiv(0, 7)).toBe(0);
  });
  it('rejects invalid input', () => {
    expect(() => roundDiv(-1, 2)).toThrow(MoneyError);
    expect(() => roundDiv(1, 0)).toThrow(MoneyError);
    expect(() => roundDiv(1.5, 2)).toThrow(MoneyError);
  });
});

describe('rateToBps', () => {
  it('parses decimal strings and numbers', () => {
    expect(rateToBps('0.1800')).toBe(1800);
    expect(rateToBps('0.18')).toBe(1800);
    expect(rateToBps(0.18)).toBe(1800);
    expect(rateToBps('0')).toBe(0);
  });
  it('rejects garbage', () => {
    expect(() => rateToBps('abc')).toThrow(MoneyError);
    expect(() => rateToBps('-0.1')).toThrow(MoneyError);
  });
});

describe('splitIgv (18 %)', () => {
  it.each([
    [11800, 10000, 1800],
    [100, 85, 15], // 84.745… -> 85
    [10000, 8475, 1525], // 8474.58… -> 8475
    [1, 1, 0], // 0.847… -> 1
    [0, 0, 0],
    [59000, 50000, 9000],
    [12345, 10462, 1883], // 10461.86… -> 10462
  ])('total %i => taxable %i + igv %i', (total, taxable, igv) => {
    expect(splitIgv(total)).toEqual({
      totalCents: total,
      taxableCents: taxable,
      igvCents: igv,
    });
  });

  it('always adds back to the total', () => {
    for (let total = 0; total <= 5000; total += 7) {
      const { taxableCents, igvCents } = splitIgv(total);
      expect(taxableCents + igvCents).toBe(total);
      expect(igvCents).toBeGreaterThanOrEqual(0);
    }
  });

  it('supports other rates and zero rate', () => {
    expect(splitIgv(1000, 0)).toEqual({
      totalCents: 1000,
      taxableCents: 1000,
      igvCents: 0,
    });
  });

  it('rejects negative or fractional totals', () => {
    expect(() => splitIgv(-1)).toThrow(MoneyError);
    expect(() => splitIgv(10.5)).toThrow(MoneyError);
  });
});

describe('percentOf / computeDeposit', () => {
  it('rounds half up', () => {
    expect(percentOf(1000, 30)).toBe(300);
    expect(percentOf(1001, 50)).toBe(501); // 500.5 -> 501
    expect(percentOf(999, 33.33)).toBe(333); // 332.97 -> 333
    expect(percentOf(0, 50)).toBe(0);
    expect(percentOf(12345, 100)).toBe(12345);
  });
  it('rejects out-of-range percent', () => {
    expect(() => percentOf(100, 101)).toThrow(MoneyError);
    expect(() => percentOf(100, -1)).toThrow(MoneyError);
  });
  it('computes a deposit capped at the total', () => {
    expect(computeDeposit(15000, 30)).toBe(4500);
    expect(computeDeposit(15001, 30)).toBe(4500); // 4500.3
    expect(computeDeposit(15005, 30)).toBe(4502); // 4501.5 -> 4502
    expect(computeDeposit(15000, 100)).toBe(15000);
  });
});

describe('priceBooking', () => {
  const perPerson = {
    unit: 'PER_PERSON' as const,
    adultCents: 4500,
    childCents: 3000,
  };
  it('prices adults and children', () => {
    const result = priceBooking(perPerson, 2, 1);
    expect(result.totalCents).toBe(12000);
    expect(result.lines).toEqual([
      { label: 'adult', quantity: 2, unitCents: 4500, totalCents: 9000 },
      { label: 'child', quantity: 1, unitCents: 3000, totalCents: 3000 },
    ]);
  });
  it('charges children as adults without a child price', () => {
    const result = priceBooking({ unit: 'PER_PERSON', adultCents: 4500 }, 1, 2);
    expect(result.totalCents).toBe(13500);
  });
  it('omits the child line when there are no children', () => {
    expect(priceBooking(perPerson, 3).lines).toHaveLength(1);
  });
  it('charges a flat group price', () => {
    const rule = {
      unit: 'PER_GROUP' as const,
      adultCents: 0,
      groupCents: 25000,
    };
    expect(priceBooking(rule, 4, 2).totalCents).toBe(25000);
    expect(priceBooking(rule, 1).totalCents).toBe(25000);
  });
  it('requires groupCents for group rules', () => {
    expect(() => priceBooking({ unit: 'PER_GROUP', adultCents: 1 }, 2)).toThrow(
      MoneyError,
    );
  });
  it('rejects invalid party sizes', () => {
    expect(() => priceBooking(perPerson, 0)).toThrow(MoneyError);
    expect(() => priceBooking(perPerson, 1, -1)).toThrow(MoneyError);
  });
});

describe('selectRefundTier', () => {
  const tiers = [
    { hoursBefore: 0, refundPercent: 0 },
    { hoursBefore: 48, refundPercent: 100 },
    { hoursBefore: 24, refundPercent: 50 },
  ];
  it('picks the tier whose lead time is still met', () => {
    expect(selectRefundTier(tiers, 100)?.refundPercent).toBe(100);
    expect(selectRefundTier(tiers, 48)?.refundPercent).toBe(100);
    expect(selectRefundTier(tiers, 47.99)?.refundPercent).toBe(50);
    expect(selectRefundTier(tiers, 24)?.refundPercent).toBe(50);
    expect(selectRefundTier(tiers, 23.5)?.refundPercent).toBe(0);
  });
  it('returns null when no tier is met (after departure)', () => {
    expect(selectRefundTier(tiers, -1)).toBeNull();
    expect(selectRefundTier([], 10)).toBeNull();
  });
});

describe('computeRefund', () => {
  const tiers = [
    { hoursBefore: 48, refundPercent: 100 },
    { hoursBefore: 24, refundPercent: 50 },
    { hoursBefore: 0, refundPercent: 0 },
  ];
  const base = { depositRefundable: true, tiers };

  it('refunds fully when cancelled early', () => {
    expect(
      computeRefund({ ...base, paidCents: 20000, hoursUntilDeparture: 72 }),
    ).toMatchObject({
      refundCents: 20000,
      retainedCents: 0,
      refundPercent: 100,
    });
  });
  it('refunds the middle tier with rounding', () => {
    expect(
      computeRefund({ ...base, paidCents: 10001, hoursUntilDeparture: 30 }),
    ).toMatchObject({
      refundCents: 5001,
      retainedCents: 5000,
      refundPercent: 50,
    });
  });
  it('refunds nothing late or after departure', () => {
    expect(
      computeRefund({ ...base, paidCents: 10000, hoursUntilDeparture: 5 }),
    ).toMatchObject({ refundCents: 0, retainedCents: 10000 });
    expect(
      computeRefund({ ...base, paidCents: 10000, hoursUntilDeparture: -3 }),
    ).toMatchObject({ refundCents: 0, tier: null });
  });
  it('keeps a non-refundable deposit out of the refund base', () => {
    const result = computeRefund({
      ...base,
      depositRefundable: false,
      depositCents: 3000,
      paidCents: 10000,
      hoursUntilDeparture: 72,
    });
    expect(result.refundCents).toBe(7000);
    expect(result.retainedCents).toBe(3000);
  });
  it('refunds nothing when only the non-refundable deposit was paid', () => {
    expect(
      computeRefund({
        ...base,
        depositRefundable: false,
        depositCents: 3000,
        paidCents: 3000,
        hoursUntilDeparture: 72,
      }).refundCents,
    ).toBe(0);
  });
  it('never exceeds what is left after previous refunds', () => {
    const result = computeRefund({
      ...base,
      paidCents: 10000,
      refundedCents: 4000,
      hoursUntilDeparture: 72,
    });
    expect(result.refundCents).toBe(6000);
  });
  it('does not allow refunded greater than paid', () => {
    expect(() =>
      computeRefund({
        ...base,
        paidCents: 100,
        refundedCents: 200,
        hoursUntilDeparture: 72,
      }),
    ).toThrow(MoneyError);
  });
  it('refunded + retained always equals what was available', () => {
    for (let paid = 0; paid <= 3000; paid += 37) {
      for (const hours of [100, 30, 1, -1]) {
        const r = computeRefund({
          ...base,
          paidCents: paid,
          hoursUntilDeparture: hours,
        });
        expect(r.refundCents + r.retainedCents).toBe(paid);
      }
    }
  });
});

describe('priceDifference', () => {
  it('charges, refunds or nothing', () => {
    expect(priceDifference(10000, 12500)).toEqual({
      type: 'CHARGE',
      amountCents: 2500,
    });
    expect(priceDifference(10000, 7000)).toEqual({
      type: 'REFUND',
      amountCents: 3000,
    });
    expect(priceDifference(10000, 10000)).toEqual({
      type: 'NONE',
      amountCents: 0,
    });
  });
});

describe('pendingCents', () => {
  it('is total minus net paid, floored at zero', () => {
    expect(pendingCents(10000, 4000)).toBe(6000);
    expect(pendingCents(10000, 10000)).toBe(0);
    expect(pendingCents(10000, 12000)).toBe(0);
    expect(pendingCents(10000, 10000, 2000)).toBe(2000);
  });
});
