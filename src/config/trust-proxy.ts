import { isIP } from 'node:net';

/** Express's own names for address ranges, accepted in TRUST_PROXY. */
const NAMED_RANGES = new Set(['loopback', 'linklocal', 'uniquelocal']);

/** What Express's `trust proxy` setting takes. */
export type TrustProxy = number | boolean | string[];

/**
 * Which proxies may tell the API who a visitor is, through X-Forwarded-For.
 * The rate limits, the admin IP allowlist and the audit log all read the
 * address Express settles on, so trusting too much lets anyone pick their
 * own address, and trusting too little puts every visitor behind a proxy on
 * one address.
 *
 *  * `1` (the default): trust the one hop in front of the API.
 *  * `loopback,200.234.45.191`: trust the nginx on this machine and the
 *    website's server, whose Next.js server calls the API for its visitors
 *    and passes their address along. Express walks the header from the
 *    right and stops at the first address it does not trust, so an address
 *    a visitor writes into the header themselves is never believed.
 */
export function parseTrustProxy(raw: string | undefined): TrustProxy {
  const value = (raw ?? '').trim();
  if (value === '') return 1;
  if (/^\d+$/.test(value)) return Number(value);
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Whether every entry is a named range, an address, or an address range. */
export function isValidTrustProxy(raw: string): boolean {
  const parsed = parseTrustProxy(raw);
  if (!Array.isArray(parsed)) return true;
  return (
    parsed.length > 0 &&
    parsed.every((entry) => {
      if (NAMED_RANGES.has(entry)) return true;
      const [address, bits, ...rest] = entry.split('/');
      if (rest.length > 0 || !address || isIP(address) === 0) return false;
      if (bits === undefined) return true;
      const max = isIP(address) === 4 ? 32 : 128;
      return /^\d+$/.test(bits) && Number(bits) <= max;
    })
  );
}
