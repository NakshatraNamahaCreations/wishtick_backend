import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type { Redis } from 'ioredis';
import { AppException } from 'src/common/errors/app.exception';
import { ErrorCode } from 'src/common/errors/error-codes';
import { REDIS_CLIENT } from './redis.constants';

export interface Lock {
  key: string;
  token: string;
  release: () => Promise<void>;
  extend: (ttlMs: number) => Promise<boolean>;
}

export interface AcquireOptions {
  /** Lock lifetime. Must exceed the worst-case critical section, or two holders can overlap. */
  ttlMs?: number;
  /** How many times to retry before giving up. 0 = fail fast. */
  retries?: number;
  /** Base delay between retries; jitter is added to avoid a thundering herd. */
  retryDelayMs?: number;
}

/**
 * Mutual exclusion over a single Redis primary (SET NX PX + fenced release).
 *
 * This is intentionally NOT multi-master Redlock: we run one Redis primary, and
 * Redlock across replicas of a single primary buys nothing. If Redis is ever
 * sharded across independent masters, this is the one class that changes.
 *
 * Correctness relies on:
 *  - a unique token per acquisition, so a holder can only release its OWN lock
 *    (a naive DEL would let holder A delete holder B's lock after A's TTL lapsed);
 *  - compare-and-delete / compare-and-extend in Lua, so check and act are atomic.
 */
@Injectable()
export class LockService implements OnModuleInit {
  private readonly logger = new Logger(LockService.name);

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  onModuleInit(): void {
    this.redis.defineCommand('releaseLock', {
      numberOfKeys: 1,
      lua: `
        if redis.call("get", KEYS[1]) == ARGV[1] then
          return redis.call("del", KEYS[1])
        end
        return 0
      `,
    });

    this.redis.defineCommand('extendLock', {
      numberOfKeys: 1,
      lua: `
        if redis.call("get", KEYS[1]) == ARGV[1] then
          return redis.call("pexpire", KEYS[1], ARGV[2])
        end
        return 0
      `,
    });
  }

  /** Acquires the lock or returns null. Callers that must not proceed should use withLock(). */
  async tryAcquire(key: string, options: AcquireOptions = {}): Promise<Lock | null> {
    const { ttlMs = 10_000, retries = 0, retryDelayMs = 100 } = options;
    const lockKey = `lock:${key}`;
    const token = randomBytes(16).toString('hex');

    for (let attempt = 0; attempt <= retries; attempt++) {
      const result = await this.redis.set(lockKey, token, 'PX', ttlMs, 'NX');
      if (result === 'OK') {
        return {
          key: lockKey,
          token,
          release: () => this.release(lockKey, token),
          extend: (ms: number) => this.extend(lockKey, token, ms),
        };
      }
      if (attempt < retries) {
        await this.sleep(retryDelayMs + Math.floor(Math.random() * retryDelayMs));
      }
    }
    return null;
  }

  /**
   * Runs `fn` under the lock and always releases it, including on throw.
   * Throws RESOURCE_LOCKED if the lock cannot be taken within the retry budget.
   */
  async withLock<T>(key: string, fn: () => Promise<T>, options: AcquireOptions = {}): Promise<T> {
    const lock = await this.tryAcquire(key, { retries: 3, retryDelayMs: 100, ...options });
    if (!lock) {
      throw new AppException(
        ErrorCode.RESOURCE_LOCKED,
        'This resource is being updated by someone else. Please retry.',
        409,
      );
    }
    try {
      return await fn();
    } finally {
      await lock.release().catch((err: Error) => {
        // A failed release is not fatal — the TTL will reap the lock — but it
        // means someone waits needlessly, so it must be visible.
        this.logger.error(`Failed to release lock ${lock.key}: ${err.message}`);
      });
    }
  }

  /**
   * Runs `fn` under the lock when it can be taken, and runs it ANYWAY when it
   * cannot — never failing the caller just because the lock was contended.
   *
   * For critical sections whose correctness is guaranteed *underneath* the lock
   * (a unique index, an idempotent upsert), the lock is only a contention
   * optimisation: it lets the common case serialize cheaply, but a caller that
   * cannot get it in time should still proceed and let the real guarantee
   * arbitrate, rather than being turned away with RESOURCE_LOCKED. This is what
   * makes "50 simultaneous reservers" resolve to one success and forty-nine
   * typed conflicts instead of a scattering of lock-timeout errors.
   *
   * Contrast withLock(), which throws when the lock is busy — use that when
   * proceeding without the lock would actually be unsafe.
   */
  async withBestEffortLock<T>(
    key: string,
    fn: () => Promise<T>,
    options: AcquireOptions = {},
  ): Promise<T> {
    const lock = await this.tryAcquire(key, { retries: 3, retryDelayMs: 100, ...options });
    if (!lock) {
      this.logger.warn(`Lock ${key} contended; proceeding without it (correctness backstops it)`);
    }
    try {
      return await fn();
    } finally {
      if (lock) {
        await lock.release().catch((err: Error) => {
          this.logger.error(`Failed to release lock ${lock.key}: ${err.message}`);
        });
      }
    }
  }

  private async release(lockKey: string, token: string): Promise<void> {
    await (this.redis as unknown as RedisWithLockCommands).releaseLock(lockKey, token);
  }

  private async extend(lockKey: string, token: string, ttlMs: number): Promise<boolean> {
    const res = await (this.redis as unknown as RedisWithLockCommands).extendLock(
      lockKey,
      token,
      String(ttlMs),
    );
    return res === 1;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

interface RedisWithLockCommands {
  releaseLock(key: string, token: string): Promise<number>;
  extendLock(key: string, token: string, ttlMs: string): Promise<number>;
}
