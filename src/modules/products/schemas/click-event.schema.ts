import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes, Types } from 'mongoose';

export type ClickEventDocument = HydratedDocument<ClickEvent>;

/**
 * One outbound click on an affiliate link.
 *
 * This is the record that backs a payout dispute: if the network says we sent
 * no traffic, this is our side of the story. Sprint 11 aggregates it.
 */
@Schema({ collection: 'click_events', timestamps: { createdAt: true, updatedAt: false } })
export class ClickEvent {
  _id!: Types.ObjectId;

  /**
   * Null for a click straight off the catalogue — a seller row on the product
   * page, where nothing has been saved to a wishlist yet. Was required until
   * that path existed, and the redirect is the moment of intent whether or not
   * an item backs it, so the row is still worth recording.
   */
  @Prop({ type: SchemaTypes.ObjectId, ref: 'WishlistItem', default: null })
  itemId!: Types.ObjectId | null;

  /**
   * Which seller was clicked, as an index into `Product.offers`. Null when the
   * click was on the product itself rather than a named seller.
   */
  @Prop({ type: Number, default: null })
  offerIndex!: number | null;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'Wishlist', default: null })
  wishlistId!: Types.ObjectId | null;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'Product', default: null })
  productId!: Types.ObjectId | null;

  /** Null for an anonymous click through a public share link. */
  @Prop({ type: SchemaTypes.ObjectId, ref: 'User', default: null })
  userId!: Types.ObjectId | null;

  @Prop({ type: String, default: null })
  provider!: string | null;

  /** Our own click id, echoed to the network so a conversion maps back here. */
  @Prop({ type: String, required: true })
  trackingId!: string;

  @Prop({ type: String, default: null })
  referer!: string | null;

  @Prop({ type: String, default: null })
  userAgent!: string | null;

  createdAt!: Date;
}

export const ClickEventSchema = SchemaFactory.createForClass(ClickEvent);

// Partial: catalogue clicks carry no item, and indexing their nulls would
// bloat the index for rows this lookup can never be asked about.
ClickEventSchema.index(
  { itemId: 1, createdAt: -1 },
  { partialFilterExpression: { itemId: { $type: 'objectId' } } },
);
/** Per-product attribution, which is the only index a catalogue click lands in. */
ClickEventSchema.index({ productId: 1, createdAt: -1 });
ClickEventSchema.index({ trackingId: 1 }, { unique: true });
ClickEventSchema.index({ userId: 1, createdAt: -1 });
/**
 * Clicks are high-volume and only interesting in aggregate. 180 days is enough
 * for any payout reconciliation window; Sprint 11's rollups keep the history.
 */
ClickEventSchema.index({ createdAt: 1 }, { expireAfterSeconds: 180 * 24 * 60 * 60 });
