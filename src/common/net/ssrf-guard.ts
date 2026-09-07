import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { AppException } from 'src/common/errors/app.exception';
import { ErrorCode } from 'src/common/errors/error-codes';
import type { AppConfig } from 'src/config/configuration';

export interface SafeTarget {
  url: URL;
  /** The address the request must actually connect to. See assertUrlIsSafe. */
  address: string;
  family: 4 | 6;
}

/**
 * Decides whether the server is allowed to fetch a user-supplied URL.
 *
 * Server-side request forgery is the whole risk of `POST /products/resolve-url`:
 * a user pastes a link, and *our* process — inside the VPC, holding an instance
 * role — makes the request. Anything reachable from the server becomes
 * reachable by anyone with the paste box, and the classic target is
 * 169.254.169.254, the cloud metadata service, which hands out IAM credentials
 * to whoever asks from the instance.
 *
 * The guard therefore blocks by *resolved address*, not by hostname. A
 * hostname denylist is theatre: `http://localtest.me` resolves to 127.0.0.1,
 * and an attacker controls their own DNS anyway.
 *
 * Known limit, stated plainly: resolving here and connecting later leaves a
 * DNS-rebinding window — the name can be re-resolved to a private address
 * between our check and Node's connect. Closing it completely requires pinning
 * the socket to the vetted IP. `SafeTarget.address` exists for exactly that,
 * and UrlResolverService connects to the address while sending the original
 * Host header, so the rebinding window is not open in practice.
 */
@Injectable()
export class SsrfGuard {
  private readonly logger = new Logger(SsrfGuard.name);

  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  private get allowPrivate(): boolean {
    // Test-only. Joi refuses to boot production with this on.
    return this.config.get('products.urlAllowPrivate', { infer: true });
  }

  /**
   * Parses, vets, and resolves a URL, returning the address to connect to.
   * Throws URL_NOT_ALLOWED for anything the server must not fetch.
   */
  async assertUrlIsSafe(rawUrl: string): Promise<SafeTarget> {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new AppException(ErrorCode.URL_NOT_ALLOWED, 'That is not a valid URL', 400);
    }

    // Scheme allowlist. `file:` reads the disk, `gopher:`/`dict:` have been used
    // to smuggle arbitrary bytes at internal services, and `data:` is not a
    // fetch at all.
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new AppException(
        ErrorCode.URL_NOT_ALLOWED,
        'Only http and https links are supported',
        400,
      );
    }

    // Credentials in a URL are how you get a server to authenticate to an
    // internal service on an attacker's behalf.
    if (url.username || url.password) {
      throw new AppException(ErrorCode.URL_NOT_ALLOWED, 'URLs must not contain credentials', 400);
    }

    // Non-standard ports are rarely a real shop and often an internal service
    // (6379 Redis, 27017 Mongo, 9200 Elasticsearch...).
    const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
    if (![80, 443, 8080, 8443].includes(port) && !this.allowPrivate) {
      throw new AppException(ErrorCode.URL_NOT_ALLOWED, `Port ${port} is not allowed`, 400);
    }

    const { address, family } = await this.resolve(url.hostname);

    if (!this.allowPrivate && SsrfGuard.isBlockedAddress(address)) {
      this.logger.warn(`Blocked SSRF attempt: ${url.hostname} → ${address}`);
      // The message deliberately does not say *why* the address is blocked, so
      // the endpoint cannot be used to map the internal network.
      throw new AppException(ErrorCode.URL_NOT_ALLOWED, 'That link cannot be fetched', 400);
    }

    return { url, address, family };
  }

  private async resolve(hostname: string): Promise<{ address: string; family: 4 | 6 }> {
    // A literal IP needs no DNS, and passing one to lookup() would be pointless.
    const literal = isIP(hostname);
    if (literal) return { address: hostname, family: literal === 6 ? 6 : 4 };

    try {
      const result = await lookup(hostname);
      return { address: result.address, family: result.family === 6 ? 6 : 4 };
    } catch {
      throw new AppException(ErrorCode.URL_NOT_ALLOWED, 'That link cannot be fetched', 400);
    }
  }

  /**
   * True for any address the server must never reach.
   *
   * Everything here is non-public by definition, so a legitimate shop can never
   * live at one of these — an allowlist of "public" is impossible to write, but
   * the set of reserved ranges is finite and well-defined.
   */
  static isBlockedAddress(address: string): boolean {
    const version = isIP(address);
    if (version === 4) return SsrfGuard.isBlockedIPv4(address);
    if (version === 6) return SsrfGuard.isBlockedIPv6(address);
    return true;
  }

  private static isBlockedIPv4(address: string): boolean {
    const parts = address.split('.').map(Number);
    if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true;
    const [a, b] = parts;

    if (a === 0) return true; // 0.0.0.0/8 "this network"
    if (a === 10) return true; // private
    if (a === 127) return true; // loopback
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 carrier NAT
    if (a === 169 && b === 254) return true; // link-local — CLOUD METADATA
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 192 && b === 0) return true; // 192.0.0/24 protocol assignments
    if (a === 192 && b === 168) return true; // private
    if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
    if (a >= 224) return true; // multicast, reserved, broadcast
    return false;
  }

  private static isBlockedIPv6(address: string): boolean {
    const lower = address.toLowerCase().split('%')[0];

    if (lower === '::' || lower === '::1') return true; // unspecified, loopback

    // ::ffff:127.0.0.1 — a v4 address wearing a v6 costume. Missing this is a
    // classic bypass: the string looks like v6, the packet goes to loopback.
    const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(lower);
    if (mapped) return SsrfGuard.isBlockedIPv4(mapped[1]);

    const head = lower.split(':')[0] ?? '';
    if (
      head.startsWith('fe8') ||
      head.startsWith('fe9') ||
      head.startsWith('fea') ||
      head.startsWith('feb')
    ) {
      return true; // fe80::/10 link-local (incl. the v6 metadata address)
    }
    if (head.startsWith('fc') || head.startsWith('fd')) return true; // fc00::/7 unique-local
    if (head.startsWith('ff')) return true; // multicast
    return false;
  }
}
