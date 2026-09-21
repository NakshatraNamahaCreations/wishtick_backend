import { Injectable, Logger } from '@nestjs/common';
import { AppException } from 'src/common/errors/app.exception';
import { ErrorCode } from 'src/common/errors/error-codes';
import type { NormalizedProduct } from 'src/modules/products/product.types';
import { ProductsService } from 'src/modules/products/products.service';
import {
  ImportantDatesService,
  type UpcomingOccasionView,
} from 'src/modules/profile/important-dates.service';
import { TaxonomyService } from 'src/modules/taxonomy/taxonomy.service';
import { TaxonomyKind } from 'src/modules/taxonomy/taxonomy.types';
import { SuggestionsService } from 'src/modules/suggestions/suggestions.service';
import {
  fallbackShelves,
  relationWord,
  shelfForOccasionAndRelation,
} from 'src/modules/taste/taste.curation';
import {
  CANDIDATE_POOL,
  MAX_FALLBACK_SEARCHES,
  MAX_PERSON_SECTIONS,
  MIN_SHELF_ITEMS,
  MAX_TASTE_SECTIONS,
  PERSON_SECTION_WITHIN_DAYS,
  PREMIUM_MIN_MINOR,
  PRICE_BAND_MAX_MINOR,
  SECTION_SIZE,
  audienceKeywords,
  categoriesForOccasion,
  nameForTitle,
} from './discover.curation';
import { DiscoverSectionKind, type DiscoverFeed, type DiscoverSection } from './discover.types';

/**
 * A shelf before the feed has made its products distinct from the shelves
 * above it: every candidate it drew, and where to look next if they fall
 * short.
 */
interface ShelfDraft {
  section: DiscoverSection;
  /**
   * The same category without the search words, for when the narrowed
   * search ("birthday for dad") was too thin to fill the shelf.
   */
  broaden?: string | null;
  /**
   * Next categories, in order, for when shelves above took this one's
   * products — never merely because this one is short. A shelf that is thin
   * on its own is still the right shelf for the person.
   */
  fallbacks?: string[];
}

/** Two results that are the same product, by id or by a re-listed title. */
const productKey = (p: NormalizedProduct): string => `${p.provider}:${p.externalId}`;
const titleKey = (p: NormalizedProduct): string =>
  p.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

@Injectable()
export class DiscoverService {
  private readonly logger = new Logger(DiscoverService.name);

  constructor(
    private readonly products: ProductsService,
    private readonly dates: ImportantDatesService,
    private readonly taxonomy: TaxonomyService,
    private readonly suggestions: SuggestionsService,
  ) {}

  /**
   * The Discover feed (Figma `280:131`): a shelf per approaching saved date,
   * then a price band, then the premium shelf.
   *
   * Every shelf is a real `products/search` call — see discover.curation.ts for
   * why the per-person shelves are curated by occasion rather than by the
   * recipient. A user with no saved dates simply gets the last two sections
   * rather than an empty screen.
   */
  async feed(userId: string): Promise<DiscoverFeed> {
    const [personSections, priceBand, premium] = await Promise.all([
      this.personSections(userId),
      this.priceBandSection(),
      this.premiumSection(),
    ]);

    const drafts = [...personSections, priceBand, premium].filter(
      (draft): draft is ShelfDraft => draft !== null,
    );
    return { sections: await this.distinct(drafts), generatedAt: new Date() };
  }

  /**
   * The shelves in display order, none repeating a product a shelf above it
   * showed.
   *
   * Two birthdays used to be two copies of one "electronics gift" search: the
   * same products, twice, under two different names. Each shelf now draws from
   * a pool of candidates, skips what is already on screen, and — when that
   * leaves too few — tries its next search before settling.
   *
   * Shelves that end up empty are dropped rather than rendered blank — a
   * provider outage should shorten the feed, not fill it with holes.
   */
  private async distinct(drafts: ShelfDraft[]): Promise<DiscoverSection[]> {
    const shownIds = new Set<string>();
    const shownTitles = new Set<string>();
    const unseen = (items: NormalizedProduct[]): NormalizedProduct[] =>
      items.filter((p) => !shownIds.has(productKey(p)) && !shownTitles.has(titleKey(p)));

    const sections: DiscoverSection[] = [];
    for (const { section, broaden, fallbacks = [] } of drafts) {
      let chosen = section;
      let drawn = section.items;
      let items = unseen(drawn);
      let budget = MAX_FALLBACK_SEARCHES;

      // Sequential on purpose: each search is only worth paying for if the one
      // before it came up short, and they share the vendor's rate limit.
      const retry = async (category: string | null): Promise<void> => {
        budget -= 1;
        const found = await this.safeSearch({ category, pageSize: CANDIDATE_POOL });
        const fresh = unseen(found ?? []);
        if (fresh.length <= items.length) return;
        drawn = found ?? [];
        items = fresh;
        // "Explore More" pages what the shelf now shows, not what it began as.
        chosen = {
          ...section,
          exploreQuery: { ...section.exploreQuery, category, keywords: null },
        };
      };

      if (broaden !== undefined && items.length < MIN_SHELF_ITEMS && budget > 0) {
        await retry(broaden);
      }
      for (const category of fallbacks) {
        // Short *because of* the shelves above — they took products it drew —
        // or with nothing at all to show.
        const crowdedOut =
          items.length < MIN_SHELF_ITEMS &&
          (items.length === 0 || items.length < Math.min(drawn.length, MIN_SHELF_ITEMS));
        if (!crowdedOut || budget <= 0) break;
        await retry(category);
      }

      const shown = items.slice(0, SECTION_SIZE);
      if (shown.length === 0) continue;
      for (const p of shown) {
        shownIds.add(productKey(p));
        shownTitles.add(titleKey(p));
      }
      sections.push({ ...chosen, items: shown });
    }
    return sections;
  }

  /**
   * One shelf for an occasion the user picked from Home's celebration grid.
   *
   * Exists so the grid does not have to carry a copy of the occasion →
   * category table; the curation stays in one place and the client just passes
   * the key it was given by `/onboarding/options`.
   */
  async occasionShelf(occasionKey: string, relation?: string | null): Promise<DiscoverSection> {
    const labels = await this.occasionLabels();
    const label = labels.get(occasionKey);
    if (!label) {
      throw new AppException(
        ErrorCode.TAXONOMY_VALUE_INVALID,
        `Unknown occasion '${occasionKey}'`,
        400,
      );
    }

    // The same rule the feed's person shelves use, so tapping somebody's
    // Home tile opens the shelf their Discover section already showed.
    const category = relation
      ? shelfForOccasionAndRelation(occasionKey, relation)
      : (categoriesForOccasion(occasionKey)[0] ?? null);
    // Said for whom, as the feed's own person shelves are — and the plain
    // category when that search is too narrow to fill anything.
    const keywords = audienceKeywords(occasionKey, relationWord(relation));
    const narrowed = keywords
      ? await this.safeSearch({ category, keywords, pageSize: SECTION_SIZE })
      : null;
    const items = narrowed?.length
      ? narrowed
      : await this.safeSearch({ category, pageSize: SECTION_SIZE });
    const searched = narrowed?.length ? keywords : null;

    return {
      kind: DiscoverSectionKind.PERSON_OCCASION,
      title: `Gifts for ${label}`,
      subtitle: null,
      person: null,
      maxPriceMinor: null,
      minPriceMinor: null,
      items: items ?? [],
      exploreQuery: { category, keywords: searched, minPriceMinor: null, maxPriceMinor: null },
    };
  }

  private async personSections(userId: string): Promise<ShelfDraft[]> {
    const upcoming = await this.dates.upcoming(userId, PERSON_SECTION_WITHIN_DAYS);
    if (upcoming.length === 0) return [];

    const labels = await this.occasionLabels();
    const soonest = upcoming.slice(0, MAX_PERSON_SECTIONS);

    // The soonest linked people, and only a couple of them: each taste shelf
    // is a different search per person, while the occasion shelves are the
    // shared category queries everybody's feed already warms.
    const byTaste = new Set(
      soonest
        .filter((entry) => entry.linkedUserId !== null)
        .slice(0, MAX_TASTE_SECTIONS)
        .map((entry) => entry.id),
    );

    const sections = await Promise.all(
      soonest.map((entry) =>
        byTaste.has(entry.id)
          ? this.tasteSection(userId, entry, labels)
          : this.personSection(entry, labels),
      ),
    );
    return sections.filter((draft): draft is ShelfDraft => draft !== null);
  }

  /**
   * A shelf ranked by what the person themself said they like.
   *
   * Only for a date linked to a WishMate — [ImportantDatesService] has already
   * re-checked that the two are still connected, and the suggestions service
   * checks it again before it will say anything about them.
   *
   * Held to one vendor search, the same as the occasion shelf it stands in
   * for. Falls back to that shelf whenever the ranking could not honestly be
   * called personal, so the feed never implies knowledge it does not have.
   */
  private async tasteSection(
    userId: string,
    entry: UpcomingOccasionView,
    labels: Map<string, string>,
  ): Promise<ShelfDraft | null> {
    const targetId = entry.linkedUserId;
    if (!targetId) return this.personSection(entry, labels);

    try {
      const shelf = await this.suggestions.forPerson(userId, targetId, {
        occasionKey: entry.occasionKey,
        relation: entry.relation,
        limit: SECTION_SIZE,
        maxQueries: 1,
      });
      if (!shelf.personalised || shelf.items.length === 0) {
        return this.personSection(entry, labels);
      }

      const occasionLabel = labels.get(entry.occasionKey) ?? entry.occasionKey;
      const section: DiscoverSection = {
        kind: DiscoverSectionKind.WISHMATE_TASTE,
        // Named for the person rather than the ranking: "picked for" is a
        // claim the shelf has just earned, and `personalised` above is what
        // earns it.
        title: `Picked for ${nameForTitle(entry.personName, occasionLabel)}'s ${occasionLabel}`,
        subtitle: entry.relation || null,
        person: {
          importantDateId: entry.id,
          name: entry.personName,
          relation: entry.relation,
          occasionKey: entry.occasionKey,
          occasionLabel,
          nextOccurrence: entry.nextOccurrence,
          daysAway: entry.daysAway,
        },
        maxPriceMinor: null,
        minPriceMinor: null,
        items: shelf.items.map((item) => item.product),
        exploreQuery: shelf.exploreQuery,
      };
      // Their own ranking: no fallback category would be more theirs, so a
      // repeat is simply dropped.
      return { section };
    } catch (err) {
      // Not connected any more, or search is down: the occasion still works.
      this.logger.warn(`Taste shelf skipped for date ${entry.id}: ${(err as Error).message}`);
      return this.personSection(entry, labels);
    }
  }

  private async personSection(
    entry: UpcomingOccasionView,
    labels: Map<string, string>,
  ): Promise<ShelfDraft | null> {
    const occasionLabel = labels.get(entry.occasionKey) ?? entry.occasionKey;
    // The most apt category for this occasion *and* this person — who they are
    // to the shopper picks between the occasion's own choices. One category
    // rather than a blend, so "Explore More" can hand the same filter to
    // product search.
    const category = shelfForOccasionAndRelation(entry.occasionKey, entry.relation);
    // And the search says who it is for — "birthday for dad" — when the
    // relation is one we recognise. The plain category is the first retry, so
    // a search too narrow to fill the shelf still falls back to a full one.
    const keywords = audienceKeywords(entry.occasionKey, relationWord(entry.relation));

    const items = await this.safeSearch({ category, keywords, pageSize: CANDIDATE_POOL });
    if (items === null) return null;

    const section: DiscoverSection = {
      kind: DiscoverSectionKind.PERSON_OCCASION,
      title: `Gift suggestions for ${nameForTitle(entry.personName, occasionLabel)}'s ${occasionLabel}`,
      subtitle: entry.relation,
      person: {
        importantDateId: entry.id,
        name: entry.personName,
        relation: entry.relation,
        occasionKey: entry.occasionKey,
        occasionLabel,
        nextOccurrence: entry.nextOccurrence,
        daysAway: entry.daysAway,
      },
      maxPriceMinor: null,
      minPriceMinor: null,
      items,
      exploreQuery: { category, keywords, minPriceMinor: null, maxPriceMinor: null },
    };
    return {
      section,
      ...(keywords ? { broaden: category } : {}),
      fallbacks: fallbackShelves(entry.occasionKey, entry.relation),
    };
  }

  private async priceBandSection(): Promise<ShelfDraft | null> {
    const items = await this.safeSearch({
      maxPriceMinor: PRICE_BAND_MAX_MINOR,
      pageSize: CANDIDATE_POOL,
    });
    if (items === null) return null;

    const section: DiscoverSection = {
      kind: DiscoverSectionKind.PRICE_BAND,
      title: `Gifts Under ₹${Math.round(PRICE_BAND_MAX_MINOR / 100).toLocaleString('en-IN')}`,
      subtitle: null,
      person: null,
      maxPriceMinor: PRICE_BAND_MAX_MINOR,
      minPriceMinor: null,
      items,
      exploreQuery: { category: null, minPriceMinor: null, maxPriceMinor: PRICE_BAND_MAX_MINOR },
    };
    return { section };
  }

  private async premiumSection(): Promise<ShelfDraft | null> {
    const items = await this.safeSearch({
      minPriceMinor: PREMIUM_MIN_MINOR,
      pageSize: CANDIDATE_POOL,
    });
    if (items === null) return null;

    const section: DiscoverSection = {
      kind: DiscoverSectionKind.PREMIUM,
      title: 'Premium Picks for You',
      subtitle: null,
      person: null,
      maxPriceMinor: null,
      minPriceMinor: PREMIUM_MIN_MINOR,
      items,
      exploreQuery: { category: null, minPriceMinor: PREMIUM_MIN_MINOR, maxPriceMinor: null },
    };
    return { section };
  }

  /**
   * One shelf's worth of products, or null if search is unavailable.
   *
   * Search throws 503 when the provider is down with no cache. A single dead
   * shelf must not take the whole feed with it, so the failure is swallowed
   * here and the caller drops that section.
   */
  private async safeSearch(query: {
    category?: string | null;
    /** Extra search words — "birthday for dad". Searched with the category. */
    keywords?: string | null;
    minPriceMinor?: number;
    maxPriceMinor?: number;
    pageSize: number;
  }): Promise<NormalizedProduct[] | null> {
    try {
      const result = await this.products.search({
        q: query.keywords ?? undefined,
        category: query.category ?? undefined,
        minPriceMinor: query.minPriceMinor,
        maxPriceMinor: query.maxPriceMinor,
        page: 1,
        pageSize: query.pageSize,
      });
      return result.items;
    } catch (err) {
      this.logger.warn(
        `Discover shelf skipped (${JSON.stringify(query)}): ${(err as Error).message}`,
      );
      return null;
    }
  }

  private async occasionLabels(): Promise<Map<string, string>> {
    const options = await this.taxonomy.getOptions();
    return new Map(options[TaxonomyKind.OCCASION].map((o) => [o.key, o.label]));
  }
}
