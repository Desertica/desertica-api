import { backoffMs } from './document-worker.service';

describe('backoffMs', () => {
  it('doubles from 30 seconds and caps at one hour', () => {
    expect([1, 2, 3, 4, 5].map(backoffMs)).toEqual([
      30_000, 60_000, 120_000, 240_000, 480_000,
    ]);
    expect(backoffMs(8)).toBe(3_600_000);
    expect(backoffMs(50)).toBe(3_600_000);
  });
});
