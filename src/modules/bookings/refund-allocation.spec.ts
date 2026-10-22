import { allocateRefund } from './refund-allocation';

describe('allocateRefund', () => {
  const payments = [
    { id: 'deposit', refundableCents: 3000 },
    { id: 'balance', refundableCents: 7000 },
  ];
  it('refunds the newest payment first', () => {
    expect(allocateRefund(payments, 5000)).toEqual([
      { paymentId: 'balance', amountCents: 5000 },
    ]);
  });
  it('spills over to older payments', () => {
    expect(allocateRefund(payments, 8000)).toEqual([
      { paymentId: 'balance', amountCents: 7000 },
      { paymentId: 'deposit', amountCents: 1000 },
    ]);
  });
  it('returns an empty plan for zero and null when it does not fit', () => {
    expect(allocateRefund(payments, 0)).toEqual([]);
    expect(allocateRefund(payments, 10001)).toBeNull();
    expect(allocateRefund([], 1)).toBeNull();
  });
  it('skips payments with nothing left to refund', () => {
    expect(
      allocateRefund(
        [
          { id: 'a', refundableCents: 0 },
          { id: 'b', refundableCents: 100 },
        ],
        100,
      ),
    ).toEqual([{ paymentId: 'b', amountCents: 100 }]);
  });
});
