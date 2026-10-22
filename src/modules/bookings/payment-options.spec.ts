import { paymentOptionsFor } from './payment-options';

const base = {
  status: 'PENDING_PAYMENT',
  currency: 'USD',
  totalCents: 10000,
  depositCents: null,
  paidCents: 0,
  refundedCents: 0,
};

describe('paymentOptionsFor', () => {
  it('offers Stripe and Culqi in USD', () => {
    expect(paymentOptionsFor(base)).toEqual([
      { provider: 'STRIPE', kinds: ['FULL'] },
      { provider: 'CULQI', kinds: ['FULL'] },
    ]);
  });

  it('offers only Culqi in PEN', () => {
    expect(paymentOptionsFor({ ...base, currency: 'PEN' })).toEqual([
      { provider: 'CULQI', kinds: ['FULL'] },
    ]);
  });

  it('offers the deposit first and the balance afterwards', () => {
    const deposit = { ...base, depositCents: 3000 };
    expect(paymentOptionsFor(deposit)[0].kinds).toEqual(['DEPOSIT']);
    expect(
      paymentOptionsFor({ ...deposit, status: 'CONFIRMED', paidCents: 3000 })[0]
        .kinds,
    ).toEqual(['BALANCE']);
  });

  it('is empty without a balance or when the booking is not payable', () => {
    expect(paymentOptionsFor({ ...base, paidCents: 10000 })).toEqual([]);
    expect(paymentOptionsFor({ ...base, status: 'CANCELLED' })).toEqual([]);
    expect(paymentOptionsFor({ ...base, status: 'EXPIRED' })).toEqual([]);
  });

  it('counts refunds as balance again', () => {
    expect(
      paymentOptionsFor({
        ...base,
        status: 'CONFIRMED',
        paidCents: 10000,
        refundedCents: 4000,
      })[0].kinds,
    ).toEqual(['BALANCE']);
  });
});
