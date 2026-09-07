import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes, Types } from 'mongoose';
import { WishlistVisibility } from '../wishlist.types';

export type WishlistDocument = HydratedDocument<Wishlist>;

@Schema({ _id: false })
export class ShareLink {
  /** Opaque, rotatable. Rotating it revokes every link already sent. */
  @Prop({ type: String, required: true })
  slug!: string;

  /** SHA-256. A passcode a support engineer can read is not a passcode. */
  @Prop({ type: String, default: null })
  passcodeHash!: string | null;

  @Prop({ type: Date, default: null })
  expiresAt!: Date | null;

  @Prop({ type: Date, default: Date.now })
  rotatedAt!: Date;
}

export const ShareLinkSchema = SchemaFactory.createForClass(ShareLink);

@Schema({ _id: false })
export class WishlistStats {
  @Prop({ type: Number, default: 0 })
  itemCount!: number;

  @Prop({ type: Number, default: 0 })
  fulfilledCount!: number;
}

export const WishlistStatsSchema = SchemaFactory.createForClass(WishlistStats);

@Schema({ collection: 'wishlists', timestamps: true })
export class Wishlist {
  _id!: Types.ObjectId;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'User', required: true })
  ownerId!: Types.ObjectId;

  @Prop({ type: String, required: true, trim: true, maxlength: 140 })
  title!: string;

  @Prop({ type: String, default: null, trim: true, maxlength: 1000 })
  description!: string | null;

  /** Free text, e.g. "Ananya's Birthday" — display only, never taxonomy-validated. */
  @Prop({ type: String, default: null, trim: true, maxlength: 140 })
  occasionLabel!: string | null;

  @Prop({
    type: String,
    enum: Object.values(WishlistVisibility),
    default: WishlistVisibility.PRIVATE,
  })
  visibility!: WishlistVisibility;

  @Prop({ type: String, default: null })
  coverUrl!: string | null;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'Media', default: null })
  coverMediaId!: Types.ObjectId | null;

  /**
   * Always present, even for a private list: the owner may flip visibility at
   * any time, and minting the slug lazily would hand out a *new* link every
   * time someone toggled the setting.
   */
  @Prop({ type: ShareLinkSchema, required: true })
  share!: ShareLink;

  /** Set when the list belongs to an event. Drives EVENT_ONLY. Sprint 5. */
  @Prop({ type: SchemaTypes.ObjectId, ref: 'Event', default: null })
  eventId!: Types.ObjectId | null;

  /**
   * Who the list is *for*, when the owner picked a WishMate while naming it —
   * a birthday list made for a friend. Purely a link: the person named is not
   * asked, not told, and gets no access from it. Null for a list of one's own.
   */
  @Prop({ type: SchemaTypes.ObjectId, ref: 'User', default: null })
  forUserId!: Types.ObjectId | null;

  @Prop({ type: Boolean, default: true })
  chatEnabled!: boolean;

  /**
   * Denormalized counters for list views. The items collection is the source of
   * truth; these are maintained on write and rebuildable by recount().
   */
  @Prop({ type: WishlistStatsSchema, default: () => ({}) })
  stats!: WishlistStats;

  /**
   * Archive, not delete. A wishlist is referenced by gifts and chats, so
   * removing the row would strand a gifter's history.
   */
  @Prop({ type: Date, default: null })
  archivedAt!: Date | null;

  createdAt!: Date;
  updatedAt!: Date;
}

export const WishlistSchema = SchemaFactory.createForClass(Wishlist);

WishlistSchema.index({ ownerId: 1, archivedAt: 1 });
WishlistSchema.index({ 'share.slug': 1 }, { unique: true });
WishlistSchema.index({ eventId: 1 }, { sparse: true });
