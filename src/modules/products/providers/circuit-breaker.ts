import { Logger } from '@nestjs/common';

export enum BreakerState {
  /** Normal. Calls flow through. */
  CLOSED = 'closed',
  /** Tripped. Calls fail instantly without touching the provider. */
  OPEN = 'open',
  /** Probing. One call is allowed through to see if the provider recovered. */
  HALF_OPEN = 'half_open',
}

export interface BreakerOptions {
  /** Consecutive failures before tripping. */
  failureThreshold: number;
  /** How long to stay open before probing. */
  resetTimeoutMs: number;
}

/**
 * Stops us from hammering a provider that is already down.
 *
 * Without this, an upstream outage means every request waits out the full
 * timeout before failing — so a dead dependency turns into exhausted
 * connections and slow responses across the whole API, not just on product
 * search. Once open, calls fail in microseconds, and the caller falls back to
 * cached results instead.
 *
 * Deliberately per-instance rather than shared through Redis. Each pod protects
 * *itself* from the wait, which is the actual harm; coordinating breaker state
 * would add a Redis round trip to the hot path to save a handful of probe
 * requests. The rate limiter, whose quota really is global, is the one that
 * lives in Redis.
 */
export class CircuitBreaker {
  private readonly logger: Logger;
  private state = BreakerState.CLOSED;
  private consecutiveFailures = 0;
  private openedAt = 0;

  constructor(
    private readonly name: string,
    private readonly options: BreakerOptions,
  ) {
    this.logger = new Logger(`CircuitBreaker:${name}`);
  }

  get currentState(): BreakerState {
    // Re-evaluated on read so an idle breaker still transitions to HALF_OPEN.
    if (
      this.state === BreakerState.OPEN &&
      Date.now() - this.openedAt >= this.options.resetTimeoutMs
    ) {
      this.state = BreakerState.HALF_OPEN;
      this.logger.log(`${this.name}: half-open, probing`);
    }
    return this.state;
  }

  /** False when the call must not be attempted. */
  canAttempt(): boolean {
    return this.currentState !== BreakerState.OPEN;
  }

  recordSuccess(): void {
    if (this.state !== BreakerState.CLOSED) {
      this.logger.log(`${this.name}: recovered, closing`);
    }
    this.state = BreakerState.CLOSED;
    this.consecutiveFailures = 0;
  }

  recordFailure(): void {
    this.consecutiveFailures++;

    // A failed probe re-opens immediately: the provider just told us it is
    // still broken, so waiting for the threshold again would send more traffic
    // at something we know is down.
    if (this.state === BreakerState.HALF_OPEN) {
      this.trip();
      return;
    }
    if (this.consecutiveFailures >= this.options.failureThreshold) {
      this.trip();
    }
  }

  private trip(): void {
    this.state = BreakerState.OPEN;
    this.openedAt = Date.now();
    this.logger.warn(
      `${this.name}: tripped open after ${this.consecutiveFailures} failure(s); ` +
        `probing again in ${this.options.resetTimeoutMs}ms`,
    );
  }

  /** Test hook. */
  reset(): void {
    this.state = BreakerState.CLOSED;
    this.consecutiveFailures = 0;
    this.openedAt = 0;
  }
}
