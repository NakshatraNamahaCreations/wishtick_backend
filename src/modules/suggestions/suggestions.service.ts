import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { AppException } from 'src/common/errors/app.exception';
import { ErrorCode } from 'src/common/errors/error-codes';
import { CacheService } from 'src/infra/redis/cache.service';
import {
  ResultFreshness,
  type NormalizedProduct,
  type ProductSearchQuery,
} from '../products/product.types';
import { ProductsService } from '../products/products.service';
import { ProfileService } from '../profile/profile.service';
import { SharedEventsService } from '../events/shared-events.service';
import { TasteService } from '../taste/taste.service';
import type { TasteProfile } from '../taste/taste.types';
import { WishmateRelationship } from '../wishmates/wishmates.views';
import { WishmatesService } from '../wishmates/wishmates.service';
import {
  bandFor,
  MAX_VENDOR_QUERIES_PER_REQUEST,
  planQueries,
  SUGGESTION_PAGE_SIZE,
} from './suggestion.retrieval';
import { shelfForOccasionAndRelation } from '../taste/taste.curation';
import { SearchAllowance, VendorBudgetService } from './vendor-budget.service';
import {
  MIN_SCORE_TO_SHOW,
  colourSearchWord,
  rankForTaste,
  searchableColour,
  type RetrievedRow,
} from './suggestion.scoring';
import { inviteShelfTitle, occasionForEventType } from './invite.curation';
import {
  worstFreshness,
  type GiftSuggestionsView,
  type InviteSuggestionsView,
  type RecipientSearchView,
} from './suggestions.views';

/** A ranked shelf is kept this long, per person and per taste. */
const RESULT_CACHE_TTL_SECONDS = 900;

export const DEFAULT_SUGGESTION_LIMIT = 12;

/** How many products a guest's shelf carries — Discover's shelf size. */
const INVITE_SHELF_SIZE = 4;

export interface SuggestionOptions {
  occasionKey?: string | null;
  relation?: string | null;
  minPriceMinor?: number | null;
  maxPriceMinor?: number | null;
  limit?: number;
  /**
   * How many vendor searches this shelf may cost, at most
   * [MAX_VENDOR_QUERIES_PER_REQUEST].
   *
   * A screen asking for one person spends the full three. The Discover feed
   * asks for a shelf among five others and is held to one, so adding a
   * taste-ranked shelf there costs the same as the occasion-curated shelf it
   * replaces — the feed's bill does not grow because somebody linked a date.
   */
  maxQueries?: number;
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
    private readonly events: SharedEventsService,
    private readonly budget: VendorBudgetService,
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
    // What the caller asked for, and what today's spend still allows — the
    // smaller of the two. Charged to the viewer, who is the one browsing;
    // the person being shopped for did not ask for any of this.
    const allowance = await this.budget.allowanceFor(viewerId);
    const asked = Math.max(
      1,
      Math.min(opts.maxQueries ?? MAX_VENDOR_QUERIES_PER_REQUEST, MAX_VENDOR_QUERIES_PER_REQUEST),
    );
    const budget = allowance === SearchAllowance.FULL ? asked : 1;
    const [taste, profile] = await Promise.all([
      this.taste.profileFor(targetId, {
        audience: isSelf ? 'self' : 'others',
        occasionKey: opts.occasionKey,
        relation: opts.relation,
        minPriceMinor: opts.minPriceMinor,
        maxPriceMinor: opts.maxPriceMinor,
      }),
      this.profiles.getOrCreate(targetId),
    ]);
    const displayName = profile.displayName?.trim() || null;
    // Held below what the planner wanted, keep the plain shelf searches first:
    // they are the shared category queries Discover and the prewarm already
    // pay for, so one of them is usually a cache hit with a full page, while
    // the keyword search is this person's alone and can come back nearly
    // empty. Ranking by taste then does the personal part for free.
    const planned = planQueries(taste);
    const plan =
      budget >= planned.length
        ? planned
        : [...planned.filter((p) => !p.query.q), ...planned.filter((p) => p.query.q)].slice(
            0,
            budget,
          );

    // Keyed on the taste itself, so an edit to somebody's preferences is a
    // different key the moment it is saved — nothing has to remember to bust
    // it, and the profile module never has to know suggestions exist.
    // The allowance is part of the key: a shelf assembled out of the cache
    // alone must not be handed to the next caller who could have paid for a
    // live one, and vice versa.
    const key = `suggestions:v1:${targetId}:${this.hashOf(taste, plan, limit, allowance)}`;
    const ranked = await this.cache.wrap(key, RESULT_CACHE_TTL_SECONDS, () =>
      this.rank(taste, plan, limit, allowance, viewerId),
    );

    return {
      title: isSelf ? 'Gift ideas for you' : `Gift ideas for ${displayName ?? 'them'}`,
      person: { userId: targetId, displayName },
      ...ranked,
      note: this.noteFor(ranked.reasonCode, isSelf, displayName),
      exploreQuery: {
        // The person travels with the query, so the grid behind "Explore
        // More" goes on ranking for them page after page.
        recipientUserId: targetId,
        recipientName: displayName,
        category: taste.shelves[0] ?? null,
        minPriceMinor: null,
        // The same rule as the searches: only a price somebody asked for.
        maxPriceMinor:
          taste.budget.source === 'explicit' ? (bandFor(taste.budget.maxMinor) ?? null) : null,
      },
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * One page of a product search, for [targetId] rather than for anybody.
   *
   * Two things make it theirs. The page is ranked by their taste — colours,
   * sizes, fit, interests and budget — and every row comes back with the
   * reasons that ranking found, so the app can say why a product is there.
   * And when they have a colour we can safely search with, the same query is
   * also asked in that colour and the two pages are merged before ranking:
   * reordering alone can only promote what the vendor happened to return, and
   * "blue" is rarely in the first twenty rows for a plain "backpack".
   *
   * Nothing is dropped from the page: a page that came back short would read
   * as the end of the results. Reordered within the page, not across pages —
   * the provider's order still decides what is on page 2.
   */
  async searchFor(
    viewerId: string,
    targetId: string,
    query: ProductSearchQuery,
  ): Promise<RecipientSearchView> {
    const relationship = await this.wishmates.relationshipWithExisting(viewerId, targetId);
    if (
      relationship !== WishmateRelationship.SELF &&
      relationship !== WishmateRelationship.WISHMATES
    ) {
      throw new AppException(
        ErrorCode.NOT_WISHMATES,
        'Gift ideas are only shown for your WishMates.',
        403,
      );
    }

    const [result, taste, profile, allowance] = await Promise.all([
      this.products.search(query),
      this.taste.profileFor(targetId, {
        audience: relationship === WishmateRelationship.SELF ? 'self' : 'others',
        minPriceMinor: query.minPriceMinor ?? null,
        maxPriceMinor: query.maxPriceMinor ?? null,
      }),
      this.profiles.getOrCreate(targetId),
      this.budget.allowanceFor(viewerId),
    ]);
    const recipient = { userId: targetId, displayName: profile.displayName?.trim() || null };

    // Nothing to rank by: the provider's own order, and an honest flag.
    if (taste.completeness === 0) {
      return {
        ...result,
        items: result.items.map((product) => ({ ...product, matchScore: 0, reasons: [] })),
        recipient,
        personalised: false,
      };
    }

    const rows: RetrievedRow[] = result.items.map((product) => ({ product, foundIn: [0] }));
    const inTheirColour = await this.colourPage(query, taste, allowance);
    const seen = new Set(rows.map((row) => `${row.product.provider}:${row.product.externalId}`));
    for (const product of inTheirColour) {
      const id = `${product.provider}:${product.externalId}`;
      if (seen.has(id)) continue;
      seen.add(id);
      // Second rank: found by a narrower search than the one that was typed,
      // so it starts behind the page the reader actually asked for.
      rows.push({ product, foundIn: [1] });
    }

    const ranked = rankForTaste(rows, taste, { limit: rows.length, diverse: false });
    const items = ranked.slice(0, Math.max(result.items.length, result.pageSize)).map((item) => ({
      ...item.product,
      matchScore: Math.round(item.score * 100),
      reasons: item.reasons,
    }));
    return {
      ...result,
      items,
      recipient,
      // Their own taste moved this page, rather than only the generic signals
      // every product has. Colour and size count: they are the whole point of
      // searching for a person rather than for a thing.
      personalised: ranked.some(
        (item) => item.signals.interest > 0 || item.signals.colour > 0 || item.signals.size > 0,
      ),
    };
  }

  /**
   * The same search again in a colour they like, or nothing.
   *
   * Costs one extra vendor call, so it runs only on a full allowance and only
   * for a typed search — a category-only page is already a shelf, and this
   * would narrow it to "blue kitchenware". The failure case is deliberately
   * quiet: the page the reader asked for is already in hand, and a search that
   * did not come back is not worth an error over.
   */
  private async colourPage(
    query: ProductSearchQuery,
    taste: TasteProfile,
    allowance: SearchAllowance,
  ): Promise<NormalizedProduct[]> {
    const typed = query.q?.trim();
    if (!typed || allowance !== SearchAllowance.FULL) return [];
    const colour = searchableColour(taste.colours);
    if (!colour) return [];
    const word = colourSearchWord(colour);
    // Already asking for it: no second call to make.
    if (new RegExp(`\\b${word}\\b`, 'i').test(typed)) return [];

    try {
      const page = await this.products.search({ ...query, q: `${word} ${typed}`, page: 1 });
      return page.items;
    } catch (err) {
      this.logger.debug(`Colour search for "${word} ${typed}" skipped: ${(err as Error).message}`);
      return [];
    }
  }

  /**
   * Gift ideas for a guest holding an invite token.
   *
   * The only surface here that nobody signs in for, and the rules follow from
   * that. The shelf is curated from the *invitation* — what kind of party it
   * is, and what the host called the person it is for — and never from that
   * person's taste, however well the server knows it: the consent boundary for
   * taste is an accepted WishMate, and a guest is not one. Nothing identifying
   * goes out, so the shelf cannot be paged back into a question about them.
   *
   * One vendor search, and a failure is silence rather than an error: this is
   * somebody's wedding invitation, and a red box on it would be worse than a
   * missing shelf.
   */
  async forInvite(token: string): Promise<InviteSuggestionsView> {
    const context = await this.events.giftContextForInvite(token);
    if (!context) {
      throw new AppException(ErrorCode.INVITE_TOKEN_INVALID, 'This invite link is not valid', 404);
    }

    const occasionKey = occasionForEventType(context.type);
    const taste = await this.taste.profileFor(null, { occasionKey, relation: context.relation });
    // The same rule Discover uses for a saved date with no account, so a
    // guest and the host's own feed agree about what a mother's birthday
    // means. The builder's first shelf would ignore the relation entirely.
    const category =
      shelfForOccasionAndRelation(occasionKey, context.relation) ?? taste.shelves[0] ?? null;
    const shelf: InviteSuggestionsView = {
      title: inviteShelfTitle(context.personName),
      items: [],
      personalised: false,
      exploreQuery: { category, minPriceMinor: null, maxPriceMinor: null },
    };
    if (!category) return shelf;

    try {
      // Category-only at the shared page size: exactly the query the prewarm
      // keeps warm, so an invitation opened by a hundred guests costs one
      // search at most, and usually none.
      const result = await this.products.search({
        category,
        page: 1,
        pageSize: SUGGESTION_PAGE_SIZE,
      });
      const ranked = rankForTaste(
        result.items.map((product) => ({ product, foundIn: [0] })),
        taste,
        { limit: INVITE_SHELF_SIZE },
      );
      return { ...shelf, items: ranked.map((item) => item.product) };
    } catch (err) {
      this.logger.warn(`Invite shelf skipped: ${(err as Error).message}`);
      return shelf;
    }
  }

  private async rank(
    taste: TasteProfile,
    plan: ReturnType<typeof planQueries>,
    limit: number,
    allowance: SearchAllowance,
    viewerId: string,
  ): Promise<
    Pick<GiftSuggestionsView, 'items' | 'personalised' | 'reasonCode' | 'freshness' | 'partial'>
  > {
    // Belt and braces: the plan is capped already, and this is the line that
    // costs money if a later change to the planner forgets that.
    const searches = plan.slice(0, MAX_VENDOR_QUERIES_PER_REQUEST);
    const cachedOnly = allowance === SearchAllowance.CACHED_ONLY;
    const settled = await Promise.allSettled(
      searches.map((p) =>
        cachedOnly
          ? this.products.cachedSearch(p.query).then((hit) => {
              // Nothing cached and nothing to spend: treated as a shelf that
              // failed, so it thins the result rather than blanking it.
              if (!hit) throw new Error('nothing cached');
              return hit;
            })
          : this.products.search(p.query),
      ),
    );
    if (!cachedOnly) await this.budget.spend(viewerId, searches.length);

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
    // search itself gives, so the app already knows what to do with it. Not
    // when the spend was the reason — a budget is ours, not the provider's,
    // and answering "unavailable" would blame the vendor for our own guard.
    if (!cachedOnly && searches.length > 0 && failures === searches.length) {
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

  private hashOf(
    taste: TasteProfile,
    plan: ReturnType<typeof planQueries>,
    limit: number,
    allowance: SearchAllowance,
  ): string {
    const inputs = JSON.stringify({
      allowance,
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
