import { ipAllowed, isAllowlistEntry } from './ip-allowlist';

describe('admin IP allowlist', () => {
  it('accepts addresses and CIDR ranges, IPv4 and IPv6, and nothing else', () => {
    for (const ok of [
      '203.0.113.7',
      '10.0.0.0/8',
      '10.1.2.0/24',
      '2001:db8::1',
      '2001:db8::/48',
      '0.0.0.0/0',
    ]) {
      expect(isAllowlistEntry(ok)).toBe(true);
    }
    for (const bad of [
      '',
      'office',
      '10.0.0.0/33',
      '2001:db8::/129',
      '10.0.0.1/8/1',
      '10.0.0/24',
      '1.2.3.4/x',
    ]) {
      expect(isAllowlistEntry(bad)).toBe(false);
    }
  });

  it('allows everything when empty, and nothing without an address', () => {
    expect(ipAllowed([], '198.51.100.1')).toBe(true);
    expect(ipAllowed(['10.0.0.0/8'], null)).toBe(false);
  });

  it('matches single addresses and ranges', () => {
    const list = ['203.0.113.7', '10.20.0.0/16', '2001:db8::/32'];
    expect(ipAllowed(list, '203.0.113.7')).toBe(true);
    expect(ipAllowed(list, '203.0.113.8')).toBe(false);
    expect(ipAllowed(list, '10.20.255.4')).toBe(true);
    expect(ipAllowed(list, '10.21.0.1')).toBe(false);
    expect(ipAllowed(list, '2001:db8:abcd::5')).toBe(true);
    expect(ipAllowed(list, '2001:db9::5')).toBe(false);
  });

  it('treats an IPv4 address the socket reports as IPv6 as the IPv4 address', () => {
    expect(ipAllowed(['127.0.0.0/8'], '::ffff:127.0.0.1')).toBe(true);
    expect(ipAllowed(['10.0.0.0/8'], '::ffff:127.0.0.1')).toBe(false);
  });

  it('ignores an entry that is not an address rather than allowing everyone', () => {
    expect(ipAllowed(['not-an-ip'], '198.51.100.1')).toBe(false);
  });
});
