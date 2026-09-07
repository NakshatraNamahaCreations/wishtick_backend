import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes, Types } from 'mongoose';

export type GroupGiftInviteDocument = HydratedDocument<GroupGiftInvite>;

export enum GroupGiftInviteStatus {
  PENDING = 'pending',
  ACCEPTED = 'accepted',
  DECLINED = 'declined',
}

/**
 * An ask to chip in, addressed to one WishMate.
 *
 * Before this, joining a group gift was entirely pull: someone had to be handed
 * the share link and press Join themselves. That works for a link in a chat,
 * but it cannot answer "who have I asked, and what did they say" — and on a
 * private wishlist it silently could not work at all, because joining requires
 * being able to gift from the list the item sits on, which a link does not
 * grant.
 *
 * Accepting is therefore two things at once: it makes the invitee a member of
 * the group, and it gives them the access that membership needs. See
 * `GroupGiftInvitesService.respond`.
 */
@Schema({ collection: 'group_gift_invites', timestamps: true })
export class GroupGiftInvite {
  _id!: Types.ObjectId;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'GroupGift', required: true })
  groupGiftId!: Types.ObjectId;

  /** The WishMate being asked. */
  @Prop({ type: SchemaTypes.ObjectId, ref: 'User', required: true })
  invitedUserId!: Types.ObjectId;

  /** Who asked them — a member of the group, not necessarily the initiator. */
  @Prop({ type: SchemaTypes.ObjectId, ref: 'User', required: true })
  invitedById!: Types.ObjectId;

  @Prop({
    type: String,
    enum: Object.values(GroupGiftInviteStatus),
    default: GroupGiftInviteStatus.PENDING,
  })
  status!: GroupGiftInviteStatus;

  /** When they answered, either way. Null while pending. */
  @Prop({ type: Date, default: null })
  respondedAt!: Date | null;

  createdAt!: Date;
  updatedAt!: Date;
}

export const GroupGiftInviteSchema = SchemaFactory.createForClass(GroupGiftInvite);

/**
 * One invitation per person per group, enforced by the database.
 *
 * Two members asking the same friend at the same moment is an ordinary race,
 * not an error worth surfacing: the unique index makes the second write a
 * no-op the service can swallow, rather than leaving the invitee with two rows
 * and two notifications for one ask.
 */
GroupGiftInviteSchema.index({ groupGiftId: 1, invitedUserId: 1 }, { unique: true });

/** "What have I been asked to chip in on?" — the invitee's own list. */
GroupGiftInviteSchema.index({ invitedUserId: 1, status: 1, createdAt: -1 });
