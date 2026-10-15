import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes, Types } from 'mongoose';

export type UserBlockDocument = HydratedDocument<UserBlock>;

/**
 * The WishMates connection a block put on hold, to be given back on unblock.
 *
 * Who asked whom, and when, so the restored link is the same connection rather
 * than a new one dated today.
 */
@Schema({ _id: false })
export class HeldLink {
  @Prop({ type: SchemaTypes.ObjectId, ref: 'User', required: true })
  requesterId!: Types.ObjectId;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'User', required: true })
  addresseeId!: Types.ObjectId;

  @Prop({ type: Date, required: true })
  createdAt!: Date;

  @Prop({ type: Date, default: null })
  respondedAt!: Date | null;
}

export const HeldLinkSchema = SchemaFactory.createForClass(HeldLink);

/**
 * One person blocking another.
 *
 * A row per direction, unlike [WishLink]'s one row per pair: blocking is one
 * person's decision, and if both block each other, either unblocking must
 * leave the other's block standing.
 *
 * Its effect is read both ways — see [WishmatesService.blockedEitherWay] —
 * because a block that only stopped one side would let the blocked person
 * keep reaching the one who blocked them.
 */
@Schema({ collection: 'user_blocks', timestamps: { createdAt: true, updatedAt: false } })
export class UserBlock {
  _id!: Types.ObjectId;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'User', required: true })
  blockerId!: Types.ObjectId;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'User', required: true, index: true })
  blockedId!: Types.ObjectId;

  /**
   * The two were WishMates when the block was made: the connection is held
   * here, not ended. While it is held the blocked person can still write to
   * the blocker — the messages wait, unseen — and unblocking puts the
   * connection back. Null when there was nothing to hold.
   */
  @Prop({ type: HeldLinkSchema, default: null })
  heldLink!: HeldLink | null;

  createdAt!: Date;
}

export const UserBlockSchema = SchemaFactory.createForClass(UserBlock);

/** One block per direction; also the index the blocker's list reads by. */
UserBlockSchema.index({ blockerId: 1, blockedId: 1 }, { unique: true });
