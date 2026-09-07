import type { ConfigService } from '@nestjs/config';
import { AppException } from 'src/common/errors/app.exception';
import { ErrorCode } from 'src/common/errors/error-codes';
import { SsrfGuard } from './ssrf-guard';

describe('SsrfGuard', () => {
  const build = (allowPrivate = false): SsrfGuard => {
    const config = {
      get: (key: string) => (key === 'products.urlAllowPrivate' ? allowPrivate : undefined),
    } as unknown as ConfigService<never, true>;
    return new SsrfGuard(config);
  };

  const guard = build();

  const expectBlocked = async (url: string): Promise<void> => {
    await expect(guard.assertUrlIsSafe(url)).rejects.toBeInstanceOf(AppException);
    await guard.assertUrlIsSafe(url).catch((err: AppException) => {
      expect(err.errorCode).toBe(ErrorCode.URL_NOT_ALLOWED);
    });
  };

  describe('blocked address ranges', () => {
    /**
     * 169.254.169.254 is the one that matters most.
     *
     * It is the cloud metadata service: any process on the instance can read
     * the instance's IAM credentials from it with a plain unauthenticated GET.
     * An SSRF that reaches it hands an attacker our AWS role.
     */
    it('blocks the cloud metadata address', () => {
      expect(SsrfGuard.isBlockedAddress('169.254.169.254')).toBe(true);
    });

    it.each([
      ['0.0.0.0', 'this network'],
      ['127.0.0.1', 'loopback'],
      ['127.1.2.3', 'loopback range'],
      ['10.0.0.1', 'private'],
      ['172.16.0.1', 'private'],
      ['172.31.255.255', 'private upper bound'],
      ['192.168.1.1', 'private'],
      ['169.254.1.1', 'link-local'],
      ['100.64.0.1', 'carrier NAT'],
      ['192.0.0.1', 'protocol assignments'],
      ['198.18.0.1', 'benchmarking'],
      ['224.0.0.1', 'multicast'],
      ['255.255.255.255', 'broadcast'],
    ])('blocks %s (%s)', (address) => {
      expect(SsrfGuard.isBlockedAddress(address)).toBe(true);
    });

    it.each(['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '11.0.0.1'])(
      'allows the public address %s',
      (address) => {
        expect(SsrfGuard.isBlockedAddress(address)).toBe(false);
      },
    );

    it.each([
      ['::1', 'v6 loopback'],
      ['::', 'unspecified'],
      ['fe80::1', 'v6 link-local'],
      ['fd00::1', 'unique-local'],
      ['fc00::1', 'unique-local'],
      ['ff02::1', 'v6 multicast'],
    ])('blocks %s (%s)', (address) => {
      expect(SsrfGuard.isBlockedAddress(address)).toBe(true);
    });

    /**
     * ::ffff:127.0.0.1 is a v4 address wearing a v6 costume. A guard that only
     * pattern-matches "looks like IPv6" waves it through and the packet still
     * goes to loopback — a classic bypass.
     */
    it.each(['::ffff:127.0.0.1', '::ffff:169.254.169.254', '::ffff:10.0.0.1'])(
      'blocks the v4-mapped address %s',
      (address) => {
        expect(SsrfGuard.isBlockedAddress(address)).toBe(true);
      },
    );

    it('allows a v4-mapped public address', () => {
      expect(SsrfGuard.isBlockedAddress('::ffff:8.8.8.8')).toBe(false);
    });

    it('blocks anything that is not an IP at all', () => {
      // Fail closed: an unparseable address is not proof of safety.
      expect(SsrfGuard.isBlockedAddress('not-an-ip')).toBe(true);
      expect(SsrfGuard.isBlockedAddress('')).toBe(true);
    });
  });

  describe('URL vetting', () => {
    it.each([
      'file:///etc/passwd',
      'gopher://127.0.0.1:6379/_INFO',
      'dict://127.0.0.1:11211/stat',
      'ftp://example.com/x',
      'data:text/html,hi',
      'javascript:alert(1)',
    ])('rejects the scheme in %s', async (url) => {
      // Only http(s) is a web page. The rest are ways to reach a filesystem or
      // smuggle bytes at an internal service that speaks a line protocol.
      await expectBlocked(url);
    });

    it('rejects credentials embedded in the URL', async () => {
      // This is how you make the server authenticate to an internal service on
      // the attacker's behalf.
      await expectBlocked('http://admin:hunter2@example.com/');
    });

    it('rejects a non-web port', async () => {
      await expectBlocked('http://example.com:6379/');
      await expectBlocked('http://example.com:27017/');
    });

    it('rejects a malformed URL', async () => {
      await expectBlocked('not a url at all');
    });

    it('blocks a hostname that resolves to loopback', async () => {
      // The reason the guard checks the RESOLVED ADDRESS and not the hostname:
      // a denylist of "localhost" is trivially defeated, because an attacker
      // controls their own DNS and can point any name at 127.0.0.1.
      await expectBlocked('http://localhost/');
      await expectBlocked('http://127.0.0.1/');
      await expectBlocked('http://[::1]/');
    });

    it('returns the vetted address so the caller can pin the connection', async () => {
      // Connecting to this address rather than re-resolving the hostname is
      // what closes the DNS-rebinding window.
      const target = await guard.assertUrlIsSafe('http://8.8.8.8/product/1');
      expect(target.address).toBe('8.8.8.8');
      expect(target.url.hostname).toBe('8.8.8.8');
    });

    it('allows loopback only when explicitly configured for tests', async () => {
      const permissive = build(true);
      const target = await permissive.assertUrlIsSafe('http://127.0.0.1:8899/p/1');
      expect(target.address).toBe('127.0.0.1');
    });
  });
});
