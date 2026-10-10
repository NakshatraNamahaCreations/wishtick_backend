import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes, Types } from 'mongoose';

export type UserBlockDocument = HydratedDocument<UserBlock>;

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

  createdAt!: Date;
}

export const UserBlockSchema = SchemaFactory.createForClass(UserBlock);

/** One block per direction; also the index the blocker's list reads by. */
UserBlockSchema.index({ blockerId: 1, blockedId: 1 }, { unique: true });
