import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { CacheService } from 'src/infra/redis/cache.service';
import { UserProfile, type UserProfileDocument } from '../profile/schemas/user-profile.schema';
import type { ProductSearchQuery } from '../products/product.types';
import { ProductsService } from '../products/products.service';
import type { TastePreferences } from '../taste/taste-profile.builder';
import { TasteService } from '../taste/taste.service';
import { planQueries } from './suggestion.retrieval';

export const TASTE_PREWARM_JOB = 'taste-prewarm';

/**
 * How many taste queries are kept warm.
 *
 * Every one of these is a vendor search on a schedule, so the number is the
 * standing cost of the feature. Twelve covers the shelves the commonest
 * combinations of interests land on; the long tail stays cold and is paid for
 * by whoever asks first, exactly as before.
 */
export const TASTE_PREWARM_LIMIT = 12;

/** How many accounts the aggregation reads. A sample, not a census. */
const PROFILE_SAMPLE = 5_000;

/** The chosen queries are re-counted daily, not on every run. */
const PLAN_CACHE_KEY = 'suggestions:prewarm-plan:v1';
const PLAN_CACHE_TTL_SECONDS = 24 * 60 * 60;

export interface TastePrewarmReport {
  warmed: number;
  failed: number;
  queries: number;
}

/**
 * Keeps the searches real people's taste actually asks for already paid for.
 *
 * [SearchPrewarmService] warms what every user shares — the category shelves
 * and the two price bands — and that is most of a suggestion shelf. What it
 * cannot warm is the half that has a keyword on it ("electronics" plus
 * "photography"), because that pair comes from somebody's interests, and
 * products must not learn what an interest is.
 *
 * So the counting happens here, where taste already lives: what did accounts
 * actually pick, which searches would those picks plan, and which of those
 * come up most often. Nothing about any one account survives the count — the
 * output is a list of queries, and a query is not a person.
 */
@Injectable()
export class TastePrewarmService {
  private readonly logger = new Logger(TastePrewarmService.name);

  constructor(
    @InjectModel(UserProfile.name) private readonly profiles: Model<UserProfileDocument>,
    private readonly taste: TasteService,
    private readonly products: ProductsService,
    private readonly cache: CacheService,
  ) {}

  async prewarm(): Promise<TastePrewarmReport> {
    const queries = await this.targets();
    let warmed = 0;
    let failed = 0;

    // Sequential, like the shared prewarm beside it: these run against the
    // same vendor quota as live traffic, and a burst would push a real user's
    // search behind ours.
    for (const query of queries) {
      try {
        await this.products.search(query, { refresh: true });
        warmed += 1;
      } catch (err) {
        failed += 1;
        this.logger.debug(
          `Taste prewarm miss (${JSON.stringify(query)}): ${(err as Error).message}`,
        );
      }
    }

    this.logger.log(`Taste prewarm: ${warmed} warmed, ${failed} failed`);
    return { warmed, failed, queries: queries.length };
  }

  /**
   * The commonest planned searches, counted once a day.
   *
   * Cached because the count is the expensive half and its answer barely moves
   * — what a population likes changes over weeks, while this job runs every
   * few hours.
   */
  private async targets(): Promise<ProductSearchQuery[]> {
    return this.cache.wrap(PLAN_CACHE_KEY, PLAN_CACHE_TTL_SECONDS, () => this.countTargets());
  }

  private async countTargets(): Promise<ProductSearchQuery[]> {
    const rows = await this.profiles
      .find({ 'preferences.interests.0': { $exists: true } })
      .select({ preferences: 1, _id: 0 })
      .limit(PROFILE_SAMPLE)
      .lean()
      .exec();

    const counts = new Map<string, { query: ProductSearchQuery; seen: number }>();
    for (const row of rows) {
      const preferences = (row.preferences ?? {}) as TastePreferences;
      const profile = await this.taste.profileForPreferences(preferences);
      for (const planned of planQueries(profile)) {
        // Only the searches with a keyword on them. The plain category ones
        // are already warmed by the shared prewarm, and warming them twice
        // would spend the budget on entries that are never cold.
        if (!planned.query.q) continue;
        const key = JSON.stringify(planned.query);
        const entry = counts.get(key);
        if (entry) entry.seen += 1;
        else counts.set(key, { query: planned.query, seen: 1 });
      }
    }

    return [...counts.values()]
      .sort((a, b) => b.seen - a.seen)
      .slice(0, TASTE_PREWARM_LIMIT)
      .map((entry) => entry.query);
  }
}
