import { BlockList, isIP } from 'node:net';

/**
 * An admin's IP allowlist: single addresses or CIDR ranges, IPv4 or IPv6 —
 * `203.0.113.7`, `10.0.0.0/24`, `2001:db8::/48`.
 */

/** An IPv4 address the socket reports as IPv6 (`::ffff:10.0.0.1`) is that IPv4 address. */
function plain(ip: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  return mapped ? mapped[1] : ip;
}

/** Whether [entry] is something the allowlist can hold. */
export function isAllowlistEntry(entry: string): boolean {
  const [addr, bits, ...rest] = entry.trim().split('/');
  if (rest.length || !addr) return false;
  const family = isIP(addr);
  if (!family) return false;
  if (bits === undefined) return true;
  if (!/^\d{1,3}$/.test(bits)) return false;
  return Number(bits) <= (family === 4 ? 32 : 128);
}

/** Whether [ip] is covered by [entries]. An empty list allows everything. */
export function ipAllowed(entries: string[], ip: string | null): boolean {
  if (entries.length === 0) return true;
  if (!ip) return false;
  const address = plain(ip);
  const family = isIP(address);
  if (!family) return false;
  const list = new BlockList();
  for (const raw of entries) {
    const entry = raw.trim();
    if (!isAllowlistEntry(entry)) continue;
    const [addr, bits] = entry.split('/') as [string, string | undefined];
    const type = isIP(addr) === 4 ? 'ipv4' : 'ipv6';
    if (bits === undefined) list.addAddress(addr, type);
    else list.addSubnet(addr, Number(bits), type);
  }
  return list.check(address, family === 4 ? 'ipv4' : 'ipv6');
}
