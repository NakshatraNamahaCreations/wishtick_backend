import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import type { AppConfig } from 'src/config/configuration';
import { CacheService } from 'src/infra/redis/cache.service';
import {
  RequestOutcome,
  RequestPurpose,
  VendorRequest,
  type VendorRequestDocument,
} from '../schemas/vendor-request.schema';
import { currentSearchContext, SearchOrigin } from '../search-context';
import { CircuitBreaker } from './circuit-breaker';

/** What each guard label is for, when the label alone says. */
const LABEL_PURPOSE: Record<string, RequestPurpose> = {
  search: RequestPurpose.SEARCH,
  sync: RequestPurpose.PRICE_CHECK,
  'monetize-details': RequestPurpose.AFFILIATE_LINK,
  categories: RequestPurpose.CATEGORIES,
  amazon_product: RequestPurpose.PASTED_LINK,
  link_match: RequestPurpose.PASTED_LINK,
};

/** What a detail lookup is for depends on what the person was doing. */
const DETAIL_PURPOSE: Partial<Record<SearchOrigin, RequestPurpose>> = {
  [SearchOrigin.ADD_TO_WISHLIST]: RequestPurpose.ADD_TO_WISHLIST,
  [SearchOrigin.PASTED_LINK]: RequestPurpose.PASTED_LINK,
  [SearchOrigin.ADMIN]: RequestPurpose.ADMIN,
};

/**
 * A vendor's words when the plan's searches are used up (it answers 429) —
 * SerpApi's "run out of searches", and the credits/quota wording SearchApi.io
 * may use. Not a plain rate limit: that one clears in a minute, this one not
 * until the plan renews, so retrying it only wastes time.
 */
const PLAN_USED_UP =
  /run out of searches|out of searches|out of credits|no (remaining )?credits|credits? (are |have been )?exhausted|exhausted (your |the )?(monthly )?(credits|searches|quota)|quota exceeded/i;

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
    @Optional()
    @InjectModel(VendorRequest.name)
    private readonly requests?: Model<VendorRequestDocument>,
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
   * @param subject what is being asked about — the words, or the product —
   *   kept with the record of each request.
   */
  async run<T>(provider: string, label: string, fn: () => Promise<T>, subject = ''): Promise<T> {
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
      // Every request sent is counted, retries included: that is what the
      // vendor bills, and the admin panel weighs it against the plan.
      await this.countRequest(provider);
      try {
        const result = await ProviderGuard.withTimeout(fn(), cfg.timeoutMs, provider);
        breaker.recordSuccess();
        this.note(provider, label, subject, attempt, RequestOutcome.ANSWERED, null);
        return result;
      } catch (err) {
        lastError = err;
        this.note(provider, label, subject, attempt, ProviderGuard.outcomeOf(err), statusOf(err));

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

  /** Requests sent to [provider] in [month] (`YYYY-MM`, UTC), across every instance. */
  async requestsIn(provider: string, month: string): Promise<number> {
    const n = await this.cache.client.get(ProviderGuard.usageKey(provider, month));
    return Number(n) || 0;
  }

  /** Requests sent to [provider] on each of [days] (`YYYY-MM-DD`). */
  async requestsOnDays(provider: string, days: string[]): Promise<number[]> {
    if (days.length === 0) return [];
    const values = await this.cache.client.mget(
      ...days.map((d) => ProviderGuard.usageKey(provider, `day:${d}`)),
    );
    return values.map((v) => Number(v) || 0);
  }

  private async countRequest(provider: string): Promise<void> {
    const now = new Date().toISOString();
    const month = ProviderGuard.usageKey(provider, now.slice(0, 7));
    const day = ProviderGuard.usageKey(provider, `day:${now.slice(0, 10)}`);
    try {
      const [m, d] = await Promise.all([
        this.cache.client.incr(month),
        this.cache.client.incr(day),
      ]);
      // Months kept a little over a year, so last year's same month can be
      // compared; days long enough for a quarter's chart.
      if (m === 1) await this.cache.client.expire(month, 400 * 86_400);
      if (d === 1) await this.cache.client.expire(day, 100 * 86_400);
    } catch {
      // A counter must never stop a search.
    }
  }

  private static usageKey(provider: string, month: string): string {
    return `products:usage:${provider}:${month}`;
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
  /**
   * Notes one request sent — what for, who for, how it was answered — for the
   * admin panel. Never awaited, and never able to fail the request.
   */
  private note(
    provider: string,
    label: string,
    subject: string,
    attempt: number,
    outcome: RequestOutcome,
    status: number | null,
  ): void {
    if (!this.requests) return;
    const ctx = currentSearchContext();
    const purpose =
      label === 'details'
        ? ((ctx && DETAIL_PURPOSE[ctx.origin]) ?? RequestPurpose.PRODUCT_OPENED)
        : (LABEL_PURPOSE[label] ?? RequestPurpose.OTHER);
    const oid = (v: string | null | undefined) =>
      v && Types.ObjectId.isValid(v) ? new Types.ObjectId(v) : null;
    this.requests
      .create({
        provider,
        label,
        purpose,
        origin: purpose === RequestPurpose.SEARCH ? (ctx?.origin ?? SearchOrigin.OTHER) : null,
        userId: oid(ctx?.userId),
        forUserId: oid(ctx?.forUserId),
        subject: subject.slice(0, 200),
        attempt,
        outcome,
        status,
      })
      .catch((err: unknown) =>
        this.logger.warn(
          `Could not note a request: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
  }

  private static outcomeOf(err: unknown): RequestOutcome {
    if (ProviderGuard.planUsedUp(err)) return RequestOutcome.PLAN_USED_UP;
    if (err instanceof Error && err.name === 'ProviderTimeoutError') return RequestOutcome.TIMEOUT;
    const status = statusOf(err);
    if (status !== null && status >= 400 && status < 500) return RequestOutcome.REFUSED;
    return RequestOutcome.FAILED;
  }

  /** The plan's searches are used up: asking again cannot help until it renews. */
  private static planUsedUp(err: unknown): boolean {
    return statusOf(err) === 429 && err instanceof Error && PLAN_USED_UP.test(err.message);
  }

  private static isRetryable(err: unknown): boolean {
    if (!(err instanceof Error)) return false;
    if (err.name === 'ProviderTimeoutError') return true;
    // A 429 is usually "slow down", worth one more try — but not when it says
    // the plan is used up. That retry was a second refused request every time.
    if (ProviderGuard.planUsedUp(err)) return false;

    const status = statusOf(err);
    if (typeof status === 'number') {
      return status === 429 || status >= 500;
    }

    const code = (err as { code?: string }).code;
    return ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND'].includes(
      code ?? '',
    );
  }
}

/** The HTTP status an upstream error carries, if any. */
function statusOf(err: unknown): number | null {
  if (!err || typeof err !== 'object') return null;
  const status =
    (err as { status?: number; statusCode?: number }).status ??
    (err as { statusCode?: number }).statusCode;
  return typeof status === 'number' ? status : null;
}
