import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes, Types } from 'mongoose';
import { ItemImportance, WishlistItemStatus } from '../wishlist.types';

export type WishlistItemDocument = HydratedDocument<WishlistItem>;

@Schema({ _id: false })
export class ItemPrice {
  /**
   * Minor units (paise, cents). Never a float: 0.1 + 0.2 !== 0.3 in binary
   * floating point, and Sprint 7 sums these into group-gift totals where a
   * rounding drift is money that does not exist.
   */
  @Prop({ type: Number, default: null, min: 0 })
  amountMinor!: number | null;

  @Prop({ type: String, default: 'INR', uppercase: true, minlength: 3, maxlength: 3 })
  currency!: string;
}

export const ItemPriceSchema = SchemaFactory.createForClass(ItemPrice);

@Schema({ _id: false })
export class GiftPreferences {
  @Prop({ type: String, default: null, trim: true, maxlength: 60 })
  color!: string | null;

  @Prop({ type: String, default: null, trim: true, maxlength: 60 })
  size!: string | null;

  @Prop({ type: String, default: null, trim: true, maxlength: 500 })
  variantNotes!: string | null;
}

export const GiftPreferencesSchema = SchemaFactory.createForClass(GiftPreferences);

/**
 * What the upstream catalogue now says, when it disagrees with the snapshot.
 *
 * This is the whole point of "snapshot, don't reference": the item keeps what
 * the user chose, and any drift is recorded *beside* it for the owner to act on.
 * Overwriting the item instead would silently rewrite someone's wishlist when a
 * merchant edited a listing.
 */
@Schema({ _id: false })
export class SourceAlert {
  @Prop({ type: Date, default: null })
  priceChangedAt!: Date | null;

  /** What the catalogue charges now. The item's own price is untouched. */
  @Prop({ type: Number, default: null })
  currentAmountMinor!: number | null;

  @Prop({ type: Boolean, default: false })
  outOfStock!: boolean;

  @Prop({ type: Date, default: null })
  checkedAt!: Date | null;
}

export const SourceAlertSchema = SchemaFactory.createForClass(SourceAlert);

@Schema({ collection: 'wishlist_items', timestamps: true })
export class WishlistItem {
  _id!: Types.ObjectId;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'Wishlist', required: true })
  wishlistId!: Types.ObjectId;

  /** Denormalized from the wishlist so item queries need no join to authorize. */
  @Prop({ type: SchemaTypes.ObjectId, ref: 'User', required: true })
  ownerId!: Types.ObjectId;

  @Prop({ type: String, required: true, trim: true, maxlength: 200 })
  title!: string;

  @Prop({ type: String, default: null, trim: true, maxlength: 1000 })
  notes!: string | null;

  /** Who this gift is for — free text, mirrors ImportantDate.personName. */
  @Prop({ type: String, default: null, trim: true, maxlength: 140 })
  recipientName!: string | null;

  /** Free text, mirrors ImportantDate.relation. */
  @Prop({ type: String, default: null, trim: true, maxlength: 60 })
  relation!: string | null;

  @Prop({ type: [String], default: [] })
  imageUrls!: string[];

  @Prop({ type: [SchemaTypes.ObjectId], ref: 'Media', default: [] })
  mediaIds!: Types.ObjectId[];

  @Prop({ type: String, default: null, trim: true, maxlength: 2048 })
  productLink!: string | null;

  @Prop({ type: ItemPriceSchema, default: () => ({}) })
  price!: ItemPrice;

  /** A gift-category taxonomy key, validated on write. */
  @Prop({ type: String, default: null })
  category!: string | null;

  /** An occasion taxonomy key (same taxonomy as ImportantDate), validated on write. */
  @Prop({ type: String, default: null })
  occasionKey!: string | null;

  /** 1 = highest. Lower sorts first, matching "priority 1" in speech. */
  @Prop({ type: Number, default: 3, min: 1, max: 5 })
  priority!: number;

  @Prop({ type: String, enum: Object.values(ItemImportance), default: ItemImportance.WOULD_LOVE })
  importance!: ItemImportance;

  @Prop({ type: Number, default: 1, min: 1, max: 99 })
  quantity!: number;

  @Prop({ type: GiftPreferencesSchema, default: () => ({}) })
  giftPreferences!: GiftPreferences;

  /**
   * Owned by GiftStatusService from Sprint 6 onward. Nothing in this sprint
   * writes it except item creation (always `available`).
   */
  @Prop({
    type: String,
    enum: Object.values(WishlistItemStatus),
    default: WishlistItemStatus.AVAILABLE,
  })
  status!: WishlistItemStatus;

  /**
   * Withheld from the owner's own view of their list.
   *
   * Set only by the group-gift "Add Another Gift" flow (`4007:720`), where the
   * *host* adds a catalogue product to the recipient's wishlist. The recipient
   * never asked for it, so showing it to them would both confuse the list and
   * spoil a surprise the group chose to hide. Everyone else sees it normally —
   * they need to, or two people buy the same thing.
   *
   * Not a general privacy mechanism: the owner's *own* items are always theirs
   * to see. This flag exists because these items are not theirs.
   */
  @Prop({ type: Boolean, default: false })
  hiddenFromOwner!: boolean;

  /**
   * Set when the item was imported from the affiliate catalogue.
   *
   * Used for sync, click attribution, and analytics — never read for display.
   * The fields above are the user's own copy; see ProductImportService.
   */
  @Prop({ type: SchemaTypes.ObjectId, ref: 'Product', default: null })
  sourceProductId!: Types.ObjectId | null;

  /** Upstream drift, recorded beside the snapshot rather than applied to it. */
  @Prop({ type: SourceAlertSchema, default: null })
  sourceAlert!: SourceAlert | null;

  /**
   * Visibility of the active gift on this item, denormalized from the gift.
   *
   * Maintained by GiftStatusService (which already owns `status`), so the
   * wishlist projection can decide whether to hide a reservation from the owner
   * WITHOUT importing the gifting module — gifting depends on wishlists, so the
   * reverse would be a cycle. `hidden_from_owner` means "show the owner this
   * item as still available, to keep the surprise"; `visible` and `null` do not
   * mask. Other viewers always see the true (claimed) status regardless.
   */
  @Prop({ type: String, default: null })
  activeGiftVisibility!: string | null;

  /**
   * Manual sort order. Sparse spacing (see ItemsService.nextPosition) so a
   * single move usually rewrites one row instead of renumbering the list.
   */
  @Prop({ type: Number, required: true })
  position!: number;

  @Prop({ type: Date, default: null })
  archivedAt!: Date | null;

  createdAt!: Date;
  updatedAt!: Date;
}

export const WishlistItemSchema = SchemaFactory.createForClass(WishlistItem);

WishlistItemSchema.index({ wishlistId: 1, position: 1 });
WishlistItemSchema.index({ wishlistId: 1, status: 1 });
WishlistItemSchema.index({ wishlistId: 1, archivedAt: 1 });
WishlistItemSchema.index({ wishlistId: 1, category: 1 });
// Drives the nightly affiliate sync: which items reference a given product.
WishlistItemSchema.index({ sourceProductId: 1 }, { sparse: true });
