import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes, Types } from 'mongoose';

export type SearchLogDocument = HydratedDocument<SearchLog>;

/** How long a search is kept: long enough to see what people look for, no longer. */
export const SEARCH_LOG_TTL_DAYS = 180;

/**
 * One product search a person made: what they typed, on which store's tab,
 * how many results came back, and whether the answer came from the cache or a
 * paid call to the provider. The admin panel's search insights read these.
 *
 * Only a person's own searches — a background prewarm is not one — and only
 * the first page, so paging through results is one search, not five.
 */
@Schema({ collection: 'search_logs', timestamps: { createdAt: true, updatedAt: false } })
export class SearchLog {
  @Prop({ type: SchemaTypes.ObjectId, required: true })
  userId!: Types.ObjectId;

  /** As typed, trimmed. Empty for browsing a category without words. */
  @Prop({ type: String, default: '' })
  query!: string;

  /** Lower-cased with spaces collapsed, so "JBL  Speaker" and "jbl speaker" count together. */
  @Prop({ type: String, default: '' })
  normalized!: string;

  @Prop({ type: String, default: null })
  category!: string | null;

  /** The store tab searched, if one. */
  @Prop({ type: String, default: null })
  platform!: string | null;

  /** live | cached | stale — see ResultFreshness. */
  @Prop({ type: String, required: true })
  freshness!: string;

  @Prop({ type: Number, default: 0 })
  results!: number;

  createdAt!: Date;
}

export const SearchLogSchema = SchemaFactory.createForClass(SearchLog);
