import type { NormalizedProduct } from 'src/modules/products/product.types';

export enum DiscoverSectionKind {
  /** Curated for one saved person's approaching occasion. */
  PERSON_OCCASION = 'person_occasion',
  /** Everything under a price ceiling — "Gifts Under ₹2000". */
  PRICE_BAND = 'price_band',
  /** The top of the catalogue by price. */
  PREMIUM = 'premium',
}

/** Who a [DiscoverSectionKind.PERSON_OCCASION] section is for. */
export interface DiscoverPerson {
  /** The important-date row this section came from. */
  importantDateId: string;
  name: string;
  /** Free text, as the user typed it — "Best Friend", "Mom". */
  relation: string;
  occasionKey: string;
  /** Resolved from the taxonomy; falls back to the key if it was retired. */
  occasionLabel: string;
  /** Date-only ISO. */
  nextOccurrence: string;
  daysAway: number;
}

export interface DiscoverSection {
  kind: DiscoverSectionKind;
  /** Ready to render — "Gift suggestions for Siya's Birthday". */
  title: string;
  subtitle: string | null;
  /** Set only on PERSON_OCCASION. */
  person: DiscoverPerson | null;
  /** Set only on PRICE_BAND. Minor units. */
  maxPriceMinor: number | null;
  /** Set only on PREMIUM. Minor units. */
  minPriceMinor: number | null;
  items: NormalizedProduct[];
  /**
   * The `GET /products/search` query that produced this shelf, so "Explore
   * More" (Figma `2167:18`) can page it without the client re-deriving the
   * curation rules.
   */
  exploreQuery: DiscoverExploreQuery;
}

export interface DiscoverExploreQuery {
  category: string | null;
  minPriceMinor: number | null;
  maxPriceMinor: number | null;
}

export interface DiscoverFeed {
  sections: DiscoverSection[];
  generatedAt: Date;
}
