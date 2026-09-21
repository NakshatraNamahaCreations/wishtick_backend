import { Injectable, Logger } from '@nestjs/common';
import { CacheService } from 'src/infra/redis/cache.service';

/**
 * Vendor searches one account may cause in a day before its shelves start
 * coming out of the cache instead.
 *
 * Sized against ordinary use: a suggestion shelf costs at most three searches,
 * and most of those are the shared category queries the prewarm has already
 * paid for, so a day of normal browsing lands nowhere near this. What it
 * catches is a loop — a stuck client, a script, a screen that re-asks on every
 * rebuild — which is exactly the shape of bill nobody notices until the month
 * ends.
 */
export const DAILY_SEARCH_BUDGET = 60;

/** Past this, the shelf is whatever is already cached. */
export const DAILY_SEARCH_HARD_CAP = 120;

const SECONDS_PER_DAY = 24 * 60 * 60;

/** What a request may still do. */
export enum SearchAllowance {
  /** Everything the planner asked for. */
  FULL = 'full',
  /** One search instead of three — the best shelf, not the widest. */
  REDUCED = 'reduced',
  /** Nothing new: cached shelves only, however stale. */
  CACHED_ONLY = 'cached_only',
}

/**
 * How much of the vendor quota one account has spent today.
 *
 * Counted in Redis rather than Mongo because it is a counter that expires: the
 * key carries the UTC date and simply falls out at the end of it, so there is
 * nothing to reset and nothing to sweep.
 *
 * Losing the count is deliberately harmless — a Redis restart hands everybody
 * a fresh allowance, which is the right way for a cost guard to fail. It
 * protects the bill, it is not a security control.
 */
@Injectable()
export class VendorBudgetService {
  private readonly logger = new Logger(VendorBudgetService.name);

  constructor(private readonly cache: CacheService) {}

  /**
   * What [userId] may spend right now.
   *
   * Degrades in two steps rather than refusing: a screen that says "you have
   * browsed enough today" is a bug report, while a shelf from this morning's
   * cache is a slightly older shelf.
   */
  async allowanceFor(userId: string): Promise<SearchAllowance> {
    const spent = await this.spentToday(userId);
    if (spent >= DAILY_SEARCH_HARD_CAP) return SearchAllowance.CACHED_ONLY;
    if (spent >= DAILY_SEARCH_BUDGET) return SearchAllowance.REDUCED;
    return SearchAllowance.FULL;
  }

  /** Records searches actually sent to the vendor. */
  async spend(userId: string, searches: number): Promise<void> {
    if (searches <= 0) return;
    const key = this.keyFor(userId);
    const spent = await this.spentToday(userId);
    // The cache port is get/set, so this is read-modify-write and two requests
    // racing can lose a count. Acceptable: a budget that is occasionally one
    // search generous still bounds the day, and a lock on the hot path would
    // cost more than the search it guards.
    await this.cache.set(key, spent + searches, SECONDS_PER_DAY);
    if (spent < DAILY_SEARCH_BUDGET && spent + searches >= DAILY_SEARCH_BUDGET) {
      this.logger.warn(`Daily search budget reached for user ${userId}`);
    }
  }

  private async spentToday(userId: string): Promise<number> {
    const spent = await this.cache.get<number>(this.keyFor(userId));
    return typeof spent === 'number' ? spent : 0;
  }

  /** UTC days, so the reset is the same moment everywhere and never drifts. */
  private keyFor(userId: string): string {
    return `suggestions:budget:v1:${userId}:${new Date().toISOString().slice(0, 10)}`;
  }
}
