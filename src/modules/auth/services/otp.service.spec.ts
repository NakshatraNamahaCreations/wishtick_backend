import type { ConfigService } from '@nestjs/config';
import RedisMock from 'ioredis-mock';
import type { Redis } from 'ioredis';
import { AppException } from 'src/common/errors/app.exception';
import { ErrorCode } from 'src/common/errors/error-codes';
import { CacheService } from 'src/infra/redis/cache.service';
import { OtpPurpose } from '../auth.types';
import { OtpService } from './otp.service';

describe('OtpService', () => {
  const IDENTIFIER = 'aarav@example.com';
  const PURPOSE = OtpPurpose.VERIFY_EMAIL;

  let redis: Redis;
  let service: OtpService;

  const buildService = (overrides: Partial<Record<string, number>> = {}): OtpService => {
    const otpConfig = {
      length: 6,
      ttlSeconds: 600,
      maxAttempts: 5,
      resendCooldownSeconds: 0,
      ...overrides,
    };
    const config = {
      get: (key: string) => (key === 'otp' ? otpConfig : undefined),
    } as unknown as ConfigService<never, true>;
    return new OtpService(new CacheService(redis), config);
  };

  beforeEach(async () => {
    redis = new RedisMock();
    await redis.flushall();
    service = buildService();
  });

  const expectAppError = async (promise: Promise<unknown>, code: ErrorCode): Promise<void> => {
    await expect(promise).rejects.toBeInstanceOf(AppException);
    await promise.catch((err: AppException) => expect(err.errorCode).toBe(code));
  };

  describe('issue', () => {
    it('generates a code of the configured length', async () => {
      const code = await service.issue(PURPOSE, IDENTIFIER);
      expect(code).toMatch(/^\d{6}$/);
    });

    it('stores only a hash, never the code itself', async () => {
      const code = await service.issue(PURPOSE, IDENTIFIER);
      const raw = await redis.get(`otp:${PURPOSE}:${IDENTIFIER}`);
      // A Redis dump must not hand an attacker live codes.
      expect(raw).not.toContain(code);
      expect(raw).toContain('hash');
    });

    it('sets a TTL so an unused code cannot linger forever', async () => {
      await service.issue(PURPOSE, IDENTIFIER);
      const ttl = await redis.ttl(`otp:${PURPOSE}:${IDENTIFIER}`);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(600);
    });

    it('replaces the previous code when re-issued', async () => {
      const first = await service.issue(PURPOSE, IDENTIFIER);
      const second = await service.issue(PURPOSE, IDENTIFIER);

      await expectAppError(service.verify(PURPOSE, IDENTIFIER, first), ErrorCode.OTP_INVALID);
      await expect(service.verify(PURPOSE, IDENTIFIER, second)).resolves.toBeUndefined();
    });
  });

  describe('resend cooldown', () => {
    it('rejects a resend inside the cooldown window', async () => {
      const cooled = buildService({ resendCooldownSeconds: 60 });
      await cooled.issue(PURPOSE, IDENTIFIER);

      // Every resend is a billable SMS, and unlimited resends would also let an
      // attacker reset the attempt counter at will.
      await expectAppError(cooled.issue(PURPOSE, IDENTIFIER), ErrorCode.OTP_COOLDOWN);
    });

    it('allows a resend once the cooldown is cleared', async () => {
      const cooled = buildService({ resendCooldownSeconds: 60 });
      await cooled.issue(PURPOSE, IDENTIFIER);
      await cooled.clearCooldown(PURPOSE, IDENTIFIER);
      await expect(cooled.issue(PURPOSE, IDENTIFIER)).resolves.toMatch(/^\d{6}$/);
    });

    it('tracks cooldowns per identifier', async () => {
      const cooled = buildService({ resendCooldownSeconds: 60 });
      await cooled.issue(PURPOSE, IDENTIFIER);
      // One user's resend must not block another's.
      await expect(cooled.issue(PURPOSE, 'someone.else@example.com')).resolves.toBeTruthy();
    });
  });

  describe('verify', () => {
    it('accepts the correct code exactly once', async () => {
      const code = await service.issue(PURPOSE, IDENTIFIER);
      await expect(service.verify(PURPOSE, IDENTIFIER, code)).resolves.toBeUndefined();
      // Consumed — a replayed code must not verify a second time.
      await expectAppError(service.verify(PURPOSE, IDENTIFIER, code), ErrorCode.OTP_EXPIRED);
    });

    it('reports OTP_EXPIRED when no code was ever issued', async () => {
      await expectAppError(service.verify(PURPOSE, IDENTIFIER, '123456'), ErrorCode.OTP_EXPIRED);
    });

    it('burns the code after maxAttempts failures', async () => {
      const code = await service.issue(PURPOSE, IDENTIFIER);

      for (let i = 0; i < 4; i++) {
        await expectAppError(service.verify(PURPOSE, IDENTIFIER, '000000'), ErrorCode.OTP_INVALID);
      }
      await expectAppError(
        service.verify(PURPOSE, IDENTIFIER, '000000'),
        ErrorCode.OTP_MAX_ATTEMPTS,
      );

      // A 6-digit code is only 10^6 wide; without burning it, guessing succeeds.
      await expectAppError(service.verify(PURPOSE, IDENTIFIER, code), ErrorCode.OTP_EXPIRED);
    });

    it('counts down the attempts it reports', async () => {
      await service.issue(PURPOSE, IDENTIFIER);
      await service.verify(PURPOSE, IDENTIFIER, '000000').catch((err: AppException) => {
        expect(err.details).toEqual({ attemptsRemaining: 4 });
      });
      await service.verify(PURPOSE, IDENTIFIER, '000000').catch((err: AppException) => {
        expect(err.details).toEqual({ attemptsRemaining: 3 });
      });
    });

    it('does not extend the TTL on a failed attempt', async () => {
      await service.issue(PURPOSE, IDENTIFIER);
      const key = `otp:${PURPOSE}:${IDENTIFIER}`;

      // Shorten the TTL to simulate a code that has been alive for a while.
      await redis.expire(key, 30);
      await expectAppError(service.verify(PURPOSE, IDENTIFIER, '000000'), ErrorCode.OTP_INVALID);

      // Re-setting with a fresh TTL would let an attacker keep a code alive
      // indefinitely by guessing wrong on purpose.
      const ttl = await redis.ttl(key);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(30);
    });

    it('rejects a code issued for a different purpose', async () => {
      const code = await service.issue(OtpPurpose.VERIFY_EMAIL, IDENTIFIER);
      // Codes are salted by purpose, so an email code cannot verify a phone.
      await expectAppError(
        service.verify(OtpPurpose.VERIFY_PHONE, IDENTIFIER, code),
        ErrorCode.OTP_EXPIRED,
      );
    });

    it('rejects a code issued for a different identifier', async () => {
      const code = await service.issue(PURPOSE, IDENTIFIER);
      await service.issue(PURPOSE, 'someone.else@example.com');
      await expectAppError(
        service.verify(PURPOSE, 'someone.else@example.com', code),
        ErrorCode.OTP_INVALID,
      );
    });
  });
});
