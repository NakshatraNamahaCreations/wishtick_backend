import { isValidTrustProxy, parseTrustProxy } from './trust-proxy';

describe('parseTrustProxy', () => {
  it('keeps today’s behaviour when unset: one hop', () => {
    expect(parseTrustProxy(undefined)).toBe(1);
    expect(parseTrustProxy('')).toBe(1);
  });

  it('reads a hop count and true/false', () => {
    expect(parseTrustProxy('2')).toBe(2);
    expect(parseTrustProxy('true')).toBe(true);
    expect(parseTrustProxy('false')).toBe(false);
  });

  it('reads a list of trusted proxies', () => {
    expect(parseTrustProxy('loopback, 200.234.45.191')).toEqual(['loopback', '200.234.45.191']);
  });
});

describe('isValidTrustProxy', () => {
  it('takes named ranges, addresses and address ranges', () => {
    expect(isValidTrustProxy('loopback,200.234.45.191')).toBe(true);
    expect(isValidTrustProxy('10.0.0.0/8,::1')).toBe(true);
    expect(isValidTrustProxy('1')).toBe(true);
  });

  it('refuses a typo, which would otherwise trust nobody or the wrong host', () => {
    expect(isValidTrustProxy('loopbak')).toBe(false);
    expect(isValidTrustProxy('200.234.45')).toBe(false);
    expect(isValidTrustProxy('10.0.0.0/40')).toBe(false);
    expect(isValidTrustProxy('app.wishtick.com')).toBe(false);
  });
});
