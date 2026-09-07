import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from 'src/config/configuration';
import { CacheService } from 'src/infra/redis/cache.service';
import { CircuitBreaker } from './circuit-breaker';

export class ProviderUnavailableError extends Error {
  constructor(
    readonly provider: string,
    readonly reason: 'circuit_open' | 'rate_limited' | 'timeout' | 'upstream_error',
    message: string,
  ) {
    super(message);
    this.name = 'ProviderUnavailableError';
  }
}

/**
 * Everything that stands between us and a third party we do not control:
 * a global rate limit, a timeout, bounded retries with jitter, and a breaker.
 *
 * All four exist for different failure modes, and none substitutes for another:
 *  - the **rate limiter** protects the vendor's quota (and our contract);
 *  - the **timeout** stops one slow call from occupying a request forever;
 *  - **retries** ride out a single blip, but only for errors worth retrying;
 *  - the **breaker** stops us retrying into an outage for minutes on end.
 *
 * Callers catch ProviderUnavailableError and fall back to cache. Nothing here
 * ever produces a 5xx by itself.
 */
@Injectable()
export class ProviderGuard {
  private readonly logger = new Logger(ProviderGuard.name);
  private readonly breakers = new Map<string, CircuitBreaker>();

  constructor(
    private readonly cache: CacheService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  private breakerFor(provider: string): CircuitBreaker {
    let breaker = this.breakers.get(provider);
    if (!breaker) {
      const cfg = this.config.get('products', { infer: true });
      breaker = new CircuitBreaker(provider, {
        failureThreshold: cfg.breakerFailureThreshold,
        resetTimeoutMs: cfg.breakerResetMs,
      });
      this.breakers.set(provider, breaker);
    }
    return breaker;
  }

  /** Exposed for the readiness probe and tests. */
  stateOf(provider: string): string {
    return this.breakerFor(provider).currentState;
  }

  resetBreaker(provider: string): void {
    this.breakerFor(provider).reset();
  }

  /**
   * Runs a provider call under the full guard.
   *
   * @param label used in logs and as the rate-limit bucket key.
   */
  async run<T>(provider: string, label: string, fn: () => Promise<T>): Promise<T> {
    const cfg = this.config.get('products', { infer: true });
    const breaker = this.breakerFor(provider);

    if (!breaker.canAttempt()) {
      throw new ProviderUnavailableError(
        provider,
        'circuit_open',
        `${provider} is unavailable (circuit open)`,
      );
    }

    if (!(await this.consumeRateLimit(provider, cfg.rateLimitPerMinute))) {
      // NOT counted as a provider failure: we stopped the call, the provider
      // did not. Tripping the breaker here would punish the provider for our
      // own traffic and lock out other callers who still have budget.
      throw new ProviderUnavailableError(
        provider,
        'rate_limited',
        `${provider} rate limit reached`,
      );
    }

    let lastError: unknown;
    for (let attempt = 0; attempt <= cfg.maxRetries; attempt++) {
      try {
        const result = await ProviderGuard.withTimeout(fn(), cfg.timeoutMs, provider);
        breaker.recordSuccess();
        return result;
      } catch (err) {
        lastError = err;

        if (!ProviderGuard.isRetryable(err)) {
          // A 4xx means the request itself is wrong; retrying just repeats it.
          breaker.recordFailure();
          break;
        }
        if (attempt < cfg.maxRetries) {
          // Full jitter: with a fixed backoff, every pod that failed at the same
          // instant retries at the same instant, and the recovering provider is
          // hit by exactly the thundering herd it just fell over to.
          const base = cfg.retryBaseDelayMs * 2 ** attempt;
          const delay = Math.floor(Math.random() * base);
          this.logger.warn(
            `${provider}/${label} attempt ${attempt + 1} failed, retrying in ${delay}ms`,
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
        } else {
          breaker.recordFailure();
        }
      }
    }

    const timedOut = lastError instanceof Error && lastError.name === 'ProviderTimeoutError';
    throw new ProviderUnavailableError(
      provider,
      timedOut ? 'timeout' : 'upstream_error',
      `${provider}/${label} failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    );
  }

  /**
   * A fixed-window counter in Redis.
   *
   * Shared across instances on purpose: the vendor's quota applies to our whole
   * account, so a per-pod limiter would let N pods spend N× the budget and get
   * the account throttled or suspended.
   */
  private async consumeRateLimit(provider: string, perMinute: number): Promise<boolean> {
    if (perMinute <= 0) return true;
    const window = Math.floor(Date.now() / 60_000);
    const key = `products:ratelimit:${provider}:${window}`;

    const count = await this.cache.client.incr(key);
    if (count === 1) {
      // Only the first caller in the window sets the TTL, so the window cannot
      // be extended indefinitely by later traffic.
      await this.cache.client.expire(key, 120);
    }
    return count <= perMinute;
  }

  private static withTimeout<T>(promise: Promise<T>, ms: number, provider: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        const err = new Error(`${provider} timed out after ${ms}ms`);
        err.name = 'ProviderTimeoutError';
        reject(err);
      }, ms);

      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (err: unknown) => {
          clearTimeout(timer);
          reject(err instanceof Error ? err : new Error(String(err)));
        },
      );
    });
  }

  /**
   * Retry only what a retry could plausibly fix.
   *
   * Timeouts, connection resets, 429s, and 5xx are transient. A 400 or a 404 is
   * a statement about the request, and repeating it three times just multiplies
   * the load and the latency for the same answer.
   */
  private static isRetryable(err: unknown): boolean {
    if (!(err instanceof Error)) return false;
    if (err.name === 'ProviderTimeoutError') return true;

    const status =
      (err as { status?: number; statusCode?: number }).status ??
      (err as { statusCode?: number }).statusCode;
    if (typeof status === 'number') {
      return status === 429 || status >= 500;
    }

    const code = (err as { code?: string }).code;
    return ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND'].includes(
      code ?? '',
    );
  }
}
