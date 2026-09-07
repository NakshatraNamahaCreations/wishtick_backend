import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes, Types } from 'mongoose';
import { ParticipantRole, ParticipantState } from '../wishlist.types';

export type WishlistParticipantDocument = HydratedDocument<WishlistParticipant>;

@Schema({ collection: 'wishlist_participants', timestamps: true })
export class WishlistParticipant {
  _id!: Types.ObjectId;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'Wishlist', required: true })
  wishlistId!: Types.ObjectId;

  /**
   * Null while the invitee has no account yet — they were invited by email.
   * Linked on signup so an invite sent before someone joined still works.
   */
  @Prop({ type: SchemaTypes.ObjectId, ref: 'User', default: null })
  userId!: Types.ObjectId | null;

  @Prop({ type: String, enum: Object.values(ParticipantRole), default: ParticipantRole.VIEWER })
  role!: ParticipantRole;

  @Prop({
    type: String,
    enum: Object.values(ParticipantState),
    default: ParticipantState.INVITED,
  })
  state!: ParticipantState;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'User', required: true })
  invitedBy!: Types.ObjectId;

  @Prop({ type: Date, default: null })
  acceptedAt!: Date | null;

  /**
   * Revocation is a state change, not a delete.
   *
   * A deleted row is indistinguishable from one that never existed, so support
   * cannot answer "why did they lose access?", and re-inviting someone would
   * silently resurrect them with no trace of the removal.
   */
  @Prop({ type: Date, default: null })
  revokedAt!: Date | null;

  createdAt!: Date;
  updatedAt!: Date;
}

export const WishlistParticipantSchema = SchemaFactory.createForClass(WishlistParticipant);

// The hot path: AccessPolicyService resolves (wishlist, user) on every request.
WishlistParticipantSchema.index({ wishlistId: 1, userId: 1 });
WishlistParticipantSchema.index({ userId: 1, state: 1 });
