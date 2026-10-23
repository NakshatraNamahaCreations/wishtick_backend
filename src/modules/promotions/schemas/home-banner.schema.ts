import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes, Types } from 'mongoose';
import { BannerPlacement } from '../home-banner.types';

export type HomeBannerDocument = HydratedDocument<HomeBanner>;

/**
 * One ad on Home — "Exclusive Offers" or "Special Offers for You" — set up in
 * the admin panel and drawn by the app as it is, with no app release needed.
 *
 * Shown while [active] and between [startsAt] and [endsAt] (either open-ended),
 * in [position] order. Nothing is ever shown that the panel has not switched
 * on, so a half-made banner can sit here as a draft.
 */
@Schema({ collection: 'home_banners', timestamps: true })
export class HomeBanner {
  _id!: Types.ObjectId;

  @Prop({ type: String, enum: Object.values(BannerPlacement), required: true })
  placement!: BannerPlacement;

  @Prop({ type: String, required: true })
  title!: string;

  @Prop({ type: String, default: null })
  subtitle!: string | null;

  /** One of ours — uploaded through the panel, never an outside address. */
  @Prop({ type: String, required: true })
  imageUrl!: string;

  /** A web page or an app screen; null for a banner that is only a picture. */
  @Prop({ type: String, default: null })
  linkUrl!: string | null;

  /** Lower first. Ties go to the newest. */
  @Prop({ type: Number, default: 0 })
  position!: number;

  @Prop({ type: Boolean, default: true })
  active!: boolean;

  @Prop({ type: Date, default: null })
  startsAt!: Date | null;

  @Prop({ type: Date, default: null })
  endsAt!: Date | null;

  /** The admin who made it, for the audit trail's sake. */
  @Prop({ type: SchemaTypes.ObjectId, default: null })
  createdBy!: Types.ObjectId | null;

  createdAt!: Date;
  updatedAt!: Date;
}

export const HomeBannerSchema = SchemaFactory.createForClass(HomeBanner);

/** What Home reads: one placement's switched-on banners, in order. */
HomeBannerSchema.index({ placement: 1, active: 1, position: 1 });
