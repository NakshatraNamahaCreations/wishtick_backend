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
import {
  MAX_PERSON_SECTIONS,
  PERSON_SECTION_WITHIN_DAYS,
  PREMIUM_MIN_MINOR,
  PRICE_BAND_MAX_MINOR,
  SECTION_SIZE,
  categoriesForOccasion,
} from './discover.curation';
import { DiscoverSectionKind, type DiscoverFeed, type DiscoverSection } from './discover.types';

@Injectable()
export class DiscoverService {
  private readonly logger = new Logger(DiscoverService.name);

  constructor(
    private readonly products: ProductsService,
    private readonly dates: ImportantDatesService,
    private readonly taxonomy: TaxonomyService,
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

    // Shelves that came back empty are dropped rather than rendered blank — a
    // provider outage should shorten the feed, not fill it with holes.
    const sections = [...personSections, priceBand, premium].filter(
      (section): section is DiscoverSection => section !== null && section.items.length > 0,
    );

    return { sections, generatedAt: new Date() };
  }

  /**
   * One shelf for an occasion the user picked from Home's celebration grid.
   *
   * Exists so the grid does not have to carry a copy of the occasion →
   * category table; the curation stays in one place and the client just passes
   * the key it was given by `/onboarding/options`.
   */
  async occasionShelf(occasionKey: string): Promise<DiscoverSection> {
    const labels = await this.occasionLabels();
    const label = labels.get(occasionKey);
    if (!label) {
      throw new AppException(
        ErrorCode.TAXONOMY_VALUE_INVALID,
        `Unknown occasion '${occasionKey}'`,
        400,
      );
    }

    const category = categoriesForOccasion(occasionKey)[0] ?? null;
    const items = await this.safeSearch({ category, pageSize: SECTION_SIZE });

    return {
      kind: DiscoverSectionKind.PERSON_OCCASION,
      title: `Gifts for ${label}`,
      subtitle: null,
      person: null,
      maxPriceMinor: null,
      minPriceMinor: null,
      items: items ?? [],
      exploreQuery: { category, minPriceMinor: null, maxPriceMinor: null },
    };
  }

  private async personSections(userId: string): Promise<DiscoverSection[]> {
    const upcoming = await this.dates.upcoming(userId, PERSON_SECTION_WITHIN_DAYS);
    if (upcoming.length === 0) return [];

    const labels = await this.occasionLabels();
    const soonest = upcoming.slice(0, MAX_PERSON_SECTIONS);

    const sections = await Promise.all(soonest.map((entry) => this.personSection(entry, labels)));
    return sections.filter((section): section is DiscoverSection => section !== null);
  }

  private async personSection(
    entry: UpcomingOccasionView,
    labels: Map<string, string>,
  ): Promise<DiscoverSection | null> {
    const occasionLabel = labels.get(entry.occasionKey) ?? entry.occasionKey;
    // The most apt category for this occasion. One category rather than a
    // blend, so "Explore More" can hand the same filter to product search.
    const category = categoriesForOccasion(entry.occasionKey)[0] ?? null;

    const items = await this.safeSearch({ category, pageSize: SECTION_SIZE });
    if (items === null) return null;

    return {
      kind: DiscoverSectionKind.PERSON_OCCASION,
      title: `Gift suggestions for ${entry.personName}'s ${occasionLabel}`,
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
      exploreQuery: { category, minPriceMinor: null, maxPriceMinor: null },
    };
  }

  private async priceBandSection(): Promise<DiscoverSection | null> {
    const items = await this.safeSearch({
      maxPriceMinor: PRICE_BAND_MAX_MINOR,
      pageSize: SECTION_SIZE,
    });
    if (items === null) return null;

    return {
      kind: DiscoverSectionKind.PRICE_BAND,
      title: `Gifts Under ₹${Math.round(PRICE_BAND_MAX_MINOR / 100).toLocaleString('en-IN')}`,
      subtitle: null,
      person: null,
      maxPriceMinor: PRICE_BAND_MAX_MINOR,
      minPriceMinor: null,
      items,
      exploreQuery: { category: null, minPriceMinor: null, maxPriceMinor: PRICE_BAND_MAX_MINOR },
    };
  }

  private async premiumSection(): Promise<DiscoverSection | null> {
    const items = await this.safeSearch({
      minPriceMinor: PREMIUM_MIN_MINOR,
      pageSize: SECTION_SIZE,
    });
    if (items === null) return null;

    return {
      kind: DiscoverSectionKind.PREMIUM,
      title: 'Premium Picks for You',
      subtitle: null,
      person: null,
      maxPriceMinor: null,
      minPriceMinor: PREMIUM_MIN_MINOR,
      items,
      exploreQuery: { category: null, minPriceMinor: PREMIUM_MIN_MINOR, maxPriceMinor: null },
    };
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
    minPriceMinor?: number;
    maxPriceMinor?: number;
    pageSize: number;
  }): Promise<NormalizedProduct[] | null> {
    try {
      const result = await this.products.search({
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
