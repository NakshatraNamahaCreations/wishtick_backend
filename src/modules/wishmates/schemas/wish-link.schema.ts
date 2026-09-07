import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes, Types } from 'mongoose';

export type WishLinkDocument = HydratedDocument<WishLink>;

export enum WishLinkStatus {
  PENDING = 'pending',
  ACCEPTED = 'accepted',
  /**
   * Kept rather than deleted, so a declined request cannot be re-sent
   * immediately in a loop. The addressee never sees it again; the requester
   * sees nothing either way, which is the point — "declined" is not a
   * notification anyone wants to receive.
   */
  DECLINED = 'declined',
}

/**
 * One connection between two users — pending, accepted or declined.
 *
 * A **single** row carries the whole relationship rather than a row per
 * direction. Two rows would let the pair drift apart (A→B accepted while
 * B→A pending is not a state that means anything), and every read would have
 * to reconcile them. The cost is that every query must look at both
 * `requesterId` and `addresseeId`, which is what [WishmatesService.pairFilter]
 * exists for.
 *
 * Direction is still preserved: `requesterId` is who asked, which is what
 * separates the Received tab from the Sent tab.
 */
@Schema({ collection: 'wish_links', timestamps: true })
export class WishLink {
  _id!: Types.ObjectId;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'User', required: true, index: true })
  requesterId!: Types.ObjectId;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'User', required: true, index: true })
  addresseeId!: Types.ObjectId;

  @Prop({
    type: String,
    enum: Object.values(WishLinkStatus),
    default: WishLinkStatus.PENDING,
    index: true,
  })
  status!: WishLinkStatus;

  /** When it stopped being pending. Null while it still is. */
  @Prop({ type: Date, default: null })
  respondedAt!: Date | null;

  createdAt!: Date;
  updatedAt!: Date;
}

export const WishLinkSchema = SchemaFactory.createForClass(WishLink);

/**
 * One link per pair, in either direction.
 *
 * The index is on the ordered pair, so it alone cannot stop A→B and B→A both
 * existing — the service normalizes the pair before writing (see
 * [WishmatesService.request], which adopts an existing opposite-direction
 * request instead of creating a second row). This index is what makes the
 * common "are these two connected?" lookup a point read.
 */
WishLinkSchema.index({ requesterId: 1, addresseeId: 1 }, { unique: true });

/** Backs the Received and Sent tabs, which filter by one side plus status. */
WishLinkSchema.index({ addresseeId: 1, status: 1 });
WishLinkSchema.index({ requesterId: 1, status: 1 });
