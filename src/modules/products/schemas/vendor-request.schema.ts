import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes, Types } from 'mongoose';

export type VendorRequestDocument = HydratedDocument<VendorRequest>;

/** What a store request was for — whatever caused it, person or schedule. */
export enum RequestPurpose {
  SEARCH = 'search',
  PRODUCT_OPENED = 'product_opened',
  ADD_TO_WISHLIST = 'add_to_wishlist',
  PASTED_LINK = 'pasted_link',
  /** The nightly re-check of products on wishlists. */
  PRICE_CHECK = 'price_check',
  /** Finding the seller's link so a click can earn commission. */
  AFFILIATE_LINK = 'affiliate_link',
  CATEGORIES = 'categories',
  ADMIN = 'admin',
  OTHER = 'other',
}

/** How the store answered one request. */
export enum RequestOutcome {
  /** It answered — the request the vendor bills for. */
  ANSWERED = 'answered',
  /** Refused because the plan's searches are used up. Not billed. */
  PLAN_USED_UP = 'plan_used_up',
  /** Refused for another reason (key, too many at once, bad request). */
  REFUSED = 'refused',
  TIMEOUT = 'timeout',
  FAILED = 'failed',
}

/**
 * One request actually sent to a store's API (SerpApi): what it was for, who
 * it was for, and how it was answered. Every attempt is one row, retries
 * included, so these add up to what the store was sent; the answered ones are
 * what it bills.
 */
@Schema({ collection: 'vendor_requests', timestamps: { createdAt: true, updatedAt: false } })
export class VendorRequest {
  @Prop({ type: String, required: true })
  provider!: string;

  /** The guard's label: search, details, sync, monetize-details, amazon_product… */
  @Prop({ type: String, required: true })
  label!: string;

  /** RequestPurpose. */
  @Prop({ type: String, required: true })
  purpose!: string;

  /** For a search, why it was searched — SearchOrigin. */
  @Prop({ type: String, default: null })
  origin!: string | null;

  /** Null for a schedule, or a guest. */
  @Prop({ type: SchemaTypes.ObjectId, default: null })
  userId!: Types.ObjectId | null;

  @Prop({ type: SchemaTypes.ObjectId, default: null })
  forUserId!: Types.ObjectId | null;

  /** What was asked about: the words searched, or the product's name. */
  @Prop({ type: String, default: '' })
  subject!: string;

  /** 0 for the first try, 1 for the first retry. */
  @Prop({ type: Number, default: 0 })
  attempt!: number;

  /** RequestOutcome. */
  @Prop({ type: String, required: true })
  outcome!: string;

  /** The HTTP status the store answered with, when it failed with one. */
  @Prop({ type: Number, default: null })
  status!: number | null;

  createdAt!: Date;
}

export const VendorRequestSchema = SchemaFactory.createForClass(VendorRequest);
