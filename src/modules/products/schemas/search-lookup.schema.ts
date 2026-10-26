import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes, Types } from 'mongoose';

export type SearchLookupDocument = HydratedDocument<SearchLookup>;

/** Kept as long as the per-day counters the admin chart draws from. */
export const SEARCH_LOOKUP_TTL_DAYS = 100;

/** How a lookup was answered. */
export enum LookupAnswer {
  /** From our cache — free. */
  CACHE = 'cache',
  /** A paid call to the store (SerpApi). */
  STORE = 'store',
  /** The same search was already on its way to the store; it shared that answer — free. */
  SHARED = 'shared',
  /** The store could not be asked or did not answer; something older was shown instead. */
  UNAVAILABLE = 'unavailable',
  /** Failed for another reason. */
  FAILED = 'failed',
}

/** What was shown when the store was unavailable. */
export enum LookupFallback {
  OLD_COPY = 'old_copy',
  SAVED_PRODUCTS = 'saved_products',
  NOTHING = 'nothing',
}

/**
 * One question product search answered: who it was for, why, what was asked,
 * and whether the cache or a paid call to the store answered it.
 *
 * The per-day chart counts the same lookups; this is the same count with
 * names on it. A typed search, a shelf of gift ideas and a Discover shelf are
 * each one or more lookups — the search log keeps only the typed ones.
 */
@Schema({ collection: 'search_lookups', timestamps: { createdAt: true, updatedAt: false } })
export class SearchLookup {
  /** Null for a guest on an invitation. */
  @Prop({ type: SchemaTypes.ObjectId, default: null })
  userId!: Types.ObjectId | null;

  /** SearchOrigin. */
  @Prop({ type: String, required: true })
  origin!: string;

  @Prop({ type: SchemaTypes.ObjectId, default: null })
  forUserId!: Types.ObjectId | null;

  /** The words sent — including any the app added, like "for women". */
  @Prop({ type: String, default: '' })
  query!: string;

  @Prop({ type: String, default: null })
  category!: string | null;

  @Prop({ type: Number, default: null })
  minPriceMinor!: number | null;

  @Prop({ type: Number, default: null })
  maxPriceMinor!: number | null;

  @Prop({ type: String, default: null })
  platform!: string | null;

  /** LookupAnswer. */
  @Prop({ type: String, required: true })
  answer!: string;

  /** Why the store was unavailable: circuit_open, rate_limited, timeout, upstream_error. */
  @Prop({ type: String, default: null })
  reason!: string | null;

  /** LookupFallback, when the store was unavailable. */
  @Prop({ type: String, default: null })
  fallback!: string | null;

  @Prop({ type: Number, default: 0 })
  results!: number;

  createdAt!: Date;
}

export const SearchLookupSchema = SchemaFactory.createForClass(SearchLookup);
