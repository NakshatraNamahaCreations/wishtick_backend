import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import { AppException } from 'src/common/errors/app.exception';
import { ErrorCode } from 'src/common/errors/error-codes';
import type { AppConfig } from 'src/config/configuration';
import { CacheService } from 'src/infra/redis/cache.service';
import type { OtpPurpose } from '../auth.types';

interface StoredOtp {
  hash: string;
  attempts: number;
  createdAt: number;
}

@Injectable()
export class OtpService {
  private readonly logger = new Logger(OtpService.name);

  constructor(
    private readonly cache: CacheService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  /**
   * Issues an OTP, enforcing a resend cooldown.
   *
   * The cooldown is not just anti-spam: without it, an attacker could burn the
   * attempt counter by forcing constant regeneration, and every resend is a real
   * SMS with a real cost attached.
   */
  async issue(purpose: OtpPurpose, identifier: string): Promise<string> {
    const cfg = this.config.get('otp', { infer: true });
    const cooldownKey = this.cooldownKey(purpose, identifier);

    const cooling = await this.cache.client.ttl(cooldownKey);
    if (cooling > 0) {
      throw new AppException(
        ErrorCode.OTP_COOLDOWN,
        `Please wait ${cooling}s before requesting another code`,
        429,
        { retryAfterSeconds: cooling },
      );
    }

    const code = this.generateCode(cfg.length);
    const record: StoredOtp = {
      hash: this.hash(code, purpose, identifier),
      attempts: 0,
      createdAt: Date.now(),
    };

    await this.cache.set(this.otpKey(purpose, identifier), record, cfg.ttlSeconds);
    if (cfg.resendCooldownSeconds > 0) {
      await this.cache.set(cooldownKey, 1, cfg.resendCooldownSeconds);
    }

    return code;
  }

  /**
   * Verifies and consumes an OTP. Consumed on success so a code cannot be
   * replayed, and burned after too many failures so it cannot be brute-forced —
   * a 6-digit code is only 10^6 wide, which falls in seconds without a cap.
   */
  async verify(purpose: OtpPurpose, identifier: string, code: string): Promise<void> {
    const cfg = this.config.get('otp', { infer: true });
    const key = this.otpKey(purpose, identifier);
    const record = await this.cache.get<StoredOtp>(key);

    if (!record) {
      throw new AppException(
        ErrorCode.OTP_EXPIRED,
        'This code has expired or was already used. Please request a new one.',
        400,
      );
    }

    if (record.attempts >= cfg.maxAttempts) {
      await this.cache.del(key);
      throw new AppException(
        ErrorCode.OTP_MAX_ATTEMPTS,
        'Too many incorrect attempts. Please request a new code.',
        429,
      );
    }

    if (!this.matches(code, record.hash, purpose, identifier)) {
      const attempts = record.attempts + 1;
      const remainingTtl = await this.cache.client.ttl(key);

      if (attempts >= cfg.maxAttempts) {
        await this.cache.del(key);
        this.logger.warn(`OTP burned after ${attempts} failed attempts (${purpose})`);
        throw new AppException(
          ErrorCode.OTP_MAX_ATTEMPTS,
          'Too many incorrect attempts. Please request a new code.',
          429,
        );
      }

      // Preserve the original TTL: re-setting with a fresh TTL would let an
      // attacker keep a code alive indefinitely by guessing wrong on purpose.
      await this.cache.set(key, { ...record, attempts }, Math.max(remainingTtl, 1));

      throw new AppException(ErrorCode.OTP_INVALID, 'Incorrect code', 400, {
        attemptsRemaining: cfg.maxAttempts - attempts,
      });
    }

    await this.cache.del(key);
  }

  /** Clears a cooldown. Used by tests and by admin-initiated resends. */
  async clearCooldown(purpose: OtpPurpose, identifier: string): Promise<void> {
    await this.cache.del(this.cooldownKey(purpose, identifier));
  }

  /** randomInt is CSPRNG-backed and rejection-samples, so digits stay uniform. */
  private generateCode(length: number): string {
    const max = 10 ** length;
    return randomInt(0, max).toString().padStart(length, '0');
  }

  /**
   * Salted with purpose+identifier so a code issued for one flow can never be
   * replayed into another, and so a Redis dump does not reveal live codes.
   */
  private hash(code: string, purpose: OtpPurpose, identifier: string): string {
    return createHash('sha256').update(`${purpose}:${identifier}:${code}`).digest('hex');
  }

  private matches(
    code: string,
    expectedHash: string,
    purpose: OtpPurpose,
    identifier: string,
  ): boolean {
    const actual = Buffer.from(this.hash(code, purpose, identifier), 'hex');
    const expected = Buffer.from(expectedHash, 'hex');
    if (actual.length !== expected.length) return false;
    return timingSafeEqual(actual, expected);
  }

  private otpKey(purpose: OtpPurpose, identifier: string): string {
    return `otp:${purpose}:${identifier}`;
  }

  private cooldownKey(purpose: OtpPurpose, identifier: string): string {
    return `otp:cooldown:${purpose}:${identifier}`;
  }
}
