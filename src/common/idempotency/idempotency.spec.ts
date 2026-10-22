import { canonicalJson, hashRequest } from './idempotency.service';

describe('idempotency hashing', () => {
  it('ignores key order, including nested objects', () => {
    expect(hashRequest({ a: 1, b: { x: 1, y: [1, { q: 1, p: 2 }] } })).toBe(
      hashRequest({ b: { y: [1, { p: 2, q: 1 }], x: 1 }, a: 1 }),
    );
  });
  it('keeps array order and distinguishes values', () => {
    expect(hashRequest({ a: [1, 2] })).not.toBe(hashRequest({ a: [2, 1] }));
    expect(hashRequest({ a: 1 })).not.toBe(hashRequest({ a: 2 }));
  });
  it('is stable', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });
});
