import { Injectable } from '@nestjs/common';
import { Algorithm, hash, verify } from '@node-rs/argon2';
import { AppException } from 'src/common/errors/app.exception';
import { ErrorCode } from 'src/common/errors/error-codes';

/**
 * OWASP-recommended argon2id parameters (19 MiB, t=2, p=1). Tuning these is a
 * security decision, not a performance one — lower them only with a rehash plan.
 */
const ARGON_OPTIONS = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

@Injectable()
export class PasswordService {
  async hash(plain: string): Promise<string> {
    return hash(plain, ARGON_OPTIONS);
  }

  async verify(hashed: string, plain: string): Promise<boolean> {
    try {
      return await verify(hashed, plain, ARGON_OPTIONS);
    } catch {
      // A malformed hash is a data problem, not a valid login.
      return false;
    }
  }

  /**
   * Length is enforced by the DTO; this catches the passwords that are long but
   * still worthless. Deliberately not a regex zoo — composition rules push users
   * toward "Password1!" while a length floor plus a common-password check does
   * more for real security.
   */
  assertStrong(plain: string, context: { email?: string; phone?: string; name?: string }): void {
    const lower = plain.toLowerCase();

    if (/^(.)\1+$/.test(plain)) {
      throw new AppException(
        ErrorCode.WEAK_PASSWORD,
        'Password cannot be a single repeated character',
        400,
      );
    }

    if (COMMON_PASSWORDS.has(lower)) {
      throw new AppException(
        ErrorCode.WEAK_PASSWORD,
        'This password is too common. Please choose something less predictable.',
        400,
      );
    }

    const localPart = context.email?.split('@')[0]?.toLowerCase();
    const personal = [localPart, context.name?.toLowerCase(), context.phone].filter(
      (v): v is string => Boolean(v && v.length >= 4),
    );
    if (personal.some((v) => lower.includes(v))) {
      throw new AppException(
        ErrorCode.WEAK_PASSWORD,
        'Password must not contain your name, email, or phone number',
        400,
      );
    }
  }
}

/**
 * A deliberately small deny-list of the passwords that show up first in every
 * credential-stuffing list. Sprint 12 swaps this for a k-anonymity check against
 * a breached-password corpus; until then this catches the worst offenders.
 */
const COMMON_PASSWORDS = new Set([
  'password',
  'password1',
  'password123',
  'passw0rd',
  '12345678',
  '123456789',
  '1234567890',
  'qwerty123',
  'qwertyuiop',
  'iloveyou',
  'admin123',
  'welcome1',
  'welcome123',
  'letmein123',
  'abc12345',
  'football',
  'baseball',
  'sunshine',
  'princess',
  'trustno1',
  'wishtick',
  'wishtick123',
]);
