import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { AppException } from 'src/common/errors/app.exception';
import { ErrorCode } from 'src/common/errors/error-codes';
import { CacheService } from 'src/infra/redis/cache.service';
import { ResultFreshness, type NormalizedProduct } from '../products/product.types';
import { ProductsService } from '../products/products.service';
import { ProfileService } from '../profile/profile.service';
import { TasteService } from '../taste/taste.service';
import type { TasteProfile } from '../taste/taste.types';
import { WishmateRelationship } from '../wishmates/wishmates.views';
import { WishmatesService } from '../wishmates/wishmates.service';
import { bandFor, MAX_VENDOR_QUERIES_PER_REQUEST, planQueries } from './suggestion.retrieval';
import { MIN_SCORE_TO_SHOW, rankForTaste, type RetrievedRow } from './suggestion.scoring';
import { worstFreshness, type GiftSuggestionsView } from './suggestions.views';

/** A ranked shelf is kept this long, per person and per taste. */
const RESULT_CACHE_TTL_SECONDS = 900;

export const DEFAULT_SUGGESTION_LIMIT = 12;

export interface SuggestionOptions {
  occasionKey?: string | null;
  minPriceMinor?: number | null;
  maxPriceMinor?: number | null;
  limit?: number;
}

/**
 * Gift ideas for one person, ranked by what they said they like.
 *
 * Retrieval and ranking are two pure functions (`suggestion.retrieval.ts`,
 * `suggestion.scoring.ts`); this is the part with I/O — who may ask, which
 * searches run, what is cached, and what happens when one of them fails.
 */
@Injectable()
export class SuggestionsService {
  private readonly logger = new Logger(SuggestionsService.name);

  constructor(
    private readonly wishmates: WishmatesService,
    private readonly taste: TasteService,
    private readonly products: ProductsService,
    private readonly profiles: ProfileService,
    private readonly cache: CacheService,
  ) {}

  /**
   * Suggestions for [targetId], asked by [viewerId].
   *
   * Only an accepted WishMate, or the person themself. Their taste is what
   * ranks the shelf, and taste is not something a stranger — or somebody with
   * a request still pending — gets to use.
   */
  async forPerson(
    viewerId: string,
    targetId: string,
    opts: SuggestionOptions = {},
  ): Promise<GiftSuggestionsView> {
    const relationship = await this.wishmates.relationshipWithExisting(viewerId, targetId);
    const isSelf = relationship === WishmateRelationship.SELF;
    if (!isSelf && relationship !== WishmateRelationship.WISHMATES) {
      throw new AppException(
        ErrorCode.NOT_WISHMATES,
        'Gift ideas are only shown for your WishMates.',
        403,
      );
    }

    const limit = opts.limit ?? DEFAULT_SUGGESTION_LIMIT;
    const [taste, profile] = await Promise.all([
      this.taste.profileFor(targetId, {
        occasionKey: opts.occasionKey,
        minPriceMinor: opts.minPriceMinor,
        maxPriceMinor: opts.maxPriceMinor,
      }),
      this.profiles.getOrCreate(targetId),
    ]);
    const displayName = profile.displayName?.trim() || null;
    const plan = planQueries(taste);

    // Keyed on the taste itself, so an edit to somebody's preferences is a
    // different key the moment it is saved — nothing has to remember to bust
    // it, and the profile module never has to know suggestions exist.
    const key = `suggestions:v1:${targetId}:${this.hashOf(taste, plan, limit)}`;
    const ranked = await this.cache.wrap(key, RESULT_CACHE_TTL_SECONDS, () =>
      this.rank(taste, plan, limit),
    );

    return {
      title: isSelf ? 'Gift ideas for you' : `Gift ideas for ${displayName ?? 'them'}`,
      person: { userId: targetId, displayName },
      ...ranked,
      note: this.noteFor(ranked.reasonCode, isSelf, displayName),
      exploreQuery: {
        category: taste.shelves[0] ?? null,
        minPriceMinor: null,
        // The same rule as the searches: only a price somebody asked for.
        maxPriceMinor:
          taste.budget.source === 'explicit' ? (bandFor(taste.budget.maxMinor) ?? null) : null,
      },
      generatedAt: new Date().toISOString(),
    };
  }

  private async rank(
    taste: TasteProfile,
    plan: ReturnType<typeof planQueries>,
    limit: number,
  ): Promise<
    Pick<GiftSuggestionsView, 'items' | 'personalised' | 'reasonCode' | 'freshness' | 'partial'>
  > {
    // Belt and braces: the plan is capped already, and this is the line that
    // costs money if a later change to the planner forgets that.
    const searches = plan.slice(0, MAX_VENDOR_QUERIES_PER_REQUEST);
    const settled = await Promise.allSettled(searches.map((p) => this.products.search(p.query)));

    const rows = new Map<string, RetrievedRow>();
    const freshness: ResultFreshness[] = [];
    let failures = 0;
    settled.forEach((outcome, index) => {
      if (outcome.status === 'rejected') {
        failures += 1;
        this.logger.warn(
          `Suggestion shelf skipped (${searches[index].reason}): ${String(outcome.reason)}`,
        );
        return;
      }
      freshness.push(outcome.value.freshness);
      for (const product of outcome.value.items) {
        this.merge(rows, product, searches[index].shelfRank);
      }
    });

    // Every search failed and nothing was cached: the same answer product
    // search itself gives, so the app already knows what to do with it.
    if (searches.length > 0 && failures === searches.length) {
      throw new AppException(
        ErrorCode.PRODUCT_SEARCH_UNAVAILABLE,
        'Gift ideas are unavailable right now. Please try again shortly.',
        503,
      );
    }

    const items = rankForTaste([...rows.values()], taste, { limit });
    const saidAnything = taste.completeness > 0;
    const matched = items.some(
      (item) => item.signals.interest > 0 && item.score >= MIN_SCORE_TO_SHOW,
    );

    return {
      items: items.map((item) => ({
        product: item.product,
        matchScore: Math.round(item.score * 100),
        reasons: item.reasons,
      })),
      personalised: saidAnything && matched,
      reasonCode: !saidAnything ? 'no_preferences' : matched ? null : 'low_confidence',
      freshness: worstFreshness(freshness),
      partial: failures > 0,
    };
  }

  /**
   * Why a shelf is not personal, in words — or null when it is.
   *
   * Honest about which it is: a shelf that went by a default must not read as
   * one that knows the person.
   */
  private noteFor(
    reasonCode: GiftSuggestionsView['reasonCode'],
    isSelf: boolean,
    displayName: string | null,
  ): string | null {
    if (reasonCode === null) return null;
    const who = isSelf ? 'You have' : `${displayName ?? 'They'} ${displayName ? 'has' : 'have'}`;
    if (reasonCode === 'no_preferences') {
      return `${who} not added any likes yet, so these are popular picks.`;
    }
    return 'Nothing here matched their likes closely — these are popular picks.';
  }

  /** One row per product; a second shelf that found it is corroboration. */
  private merge(rows: Map<string, RetrievedRow>, product: NormalizedProduct, shelfRank: number) {
    const id = `${product.provider}:${product.externalId}`;
    const existing = rows.get(id);
    if (existing) {
      if (!existing.foundIn.includes(shelfRank)) existing.foundIn.push(shelfRank);
      return;
    }
    rows.set(id, { product, foundIn: [shelfRank] });
  }

  private hashOf(taste: TasteProfile, plan: ReturnType<typeof planQueries>, limit: number): string {
    const inputs = JSON.stringify({
      tokens: taste.tokens.map((t) => [t.term, t.weight]),
      colours: taste.colours.map((c) => c.key),
      sizes: taste.sizes,
      budget: taste.budget,
      plan: plan.map((p) => p.query),
      limit,
    });
    return createHash('sha256').update(inputs).digest('hex').slice(0, 24);
  }
}
