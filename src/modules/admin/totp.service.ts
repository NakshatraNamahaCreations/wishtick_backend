import { Injectable } from '@nestjs/common';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * RFC 6238 TOTP (SHA-1, 6 digits, 30s step) — the scheme every authenticator app
 * (Google Authenticator, Authy, 1Password) implements. Kept as a tiny,
 * dependency-free implementation over `node:crypto` on purpose: the one library
 * option (otplib) pulls an ESM-only transitive dependency that loads
 * inconsistently across our Jest configs and would be a landmine at boot. The
 * maths here is small, standard, and fully under test.
 */
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_SECONDS = 30;
const DIGITS = 6;
/** Accept the code from the adjacent step in each direction — one step of skew. */
const SKEW_STEPS = 1;

@Injectable()
export class TotpService {
  /** A fresh base32 secret to store on the admin and hand to their authenticator. */
  generateSecret(): string {
    // 20 random bytes is the RFC-recommended key length for SHA-1 TOTP.
    return base32Encode(randomBytes(20));
  }

  /** The `otpauth://` URI a QR code encodes for enrollment. */
  keyUri(email: string, secret: string): string {
    const issuer = 'Wishtick Admin';
    const label = encodeURIComponent(`${issuer}:${email}`);
    const params = new URLSearchParams({
      secret,
      issuer,
      algorithm: 'SHA1',
      digits: String(DIGITS),
      period: String(STEP_SECONDS),
    });
    return `otpauth://totp/${label}?${params.toString()}`;
  }

  /**
   * Verifies a 6-digit code against the secret, allowing one step of clock skew.
   * The maths is synchronous, but the signature stays Promise-returning: token
   * verification is conventionally async, and a future remote/HSM verifier would
   * slot in without changing a single caller.
   */
  verify(token: string, secret: string): Promise<boolean> {
    if (!/^\d{6}$/.test(token)) return Promise.resolve(false);
    const counter = TotpService.counterNow();
    for (let w = -SKEW_STEPS; w <= SKEW_STEPS; w++) {
      if (TotpService.constantTimeEquals(this.codeForCounter(secret, counter + w), token)) {
        return Promise.resolve(true);
      }
    }
    return Promise.resolve(false);
  }

  /** Test/enrollment helper: the current code for a secret. */
  current(secret: string): Promise<string> {
    return Promise.resolve(this.codeForCounter(secret, TotpService.counterNow()));
  }

  private codeForCounter(secret: string, counter: number): string {
    const key = base32Decode(secret);
    const msg = Buffer.alloc(8);
    // 64-bit big-endian counter, written as two 32-bit halves (a single shift
    // would overflow JS's 32-bit bitwise range).
    msg.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
    msg.writeUInt32BE(counter >>> 0, 4);
    const hmac = createHmac('sha1', key).update(msg).digest();
    // Dynamic truncation (RFC 4226 §5.3).
    const offset = hmac[hmac.length - 1] & 0x0f;
    const binary =
      ((hmac[offset] & 0x7f) << 24) |
      ((hmac[offset + 1] & 0xff) << 16) |
      ((hmac[offset + 2] & 0xff) << 8) |
      (hmac[offset + 3] & 0xff);
    return (binary % 10 ** DIGITS).toString().padStart(DIGITS, '0');
  }

  private static counterNow(): number {
    return Math.floor(Date.now() / 1000 / STEP_SECONDS);
  }

  private static constantTimeEquals(a: string, b: string): boolean {
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    return ab.length === bb.length && timingSafeEqual(ab, bb);
  }
}

/** RFC 4648 base32 encode, no padding — the form authenticator apps expect. */
function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

/** RFC 4648 base32 decode; ignores casing, whitespace, and padding. */
function base32Decode(secret: string): Buffer {
  const clean = secret.toUpperCase().replace(/=+$/, '');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) continue; // skip separators / stray characters
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}
