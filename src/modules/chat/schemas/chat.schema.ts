import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes, Types } from 'mongoose';
import { ChatType, WhoCanPost } from '../chat.types';

export type ChatDocument = HydratedDocument<Chat>;

@Schema({ _id: false })
export class ChatSettings {
  @Prop({ type: String, enum: Object.values(WhoCanPost), default: WhoCanPost.PARTICIPANTS })
  whoCanPost!: WhoCanPost;
}

export const ChatSettingsSchema = SchemaFactory.createForClass(ChatSettings);

/**
 * A conversation attached to a wishlist or a group gift.
 *
 * `refId` points at the wishlist or group gift; the unique `(type, refId)` index
 * makes provisioning a get-or-create — a racing second create is rejected by the
 * database, not by a check. Authorization is NOT read from `participantIds`: a
 * wishlist chat is gated live through AccessPolicyService and a group-gift chat
 * through the gift's participation, so a revoked member loses access on their
 * next request without the list having to be rewritten. `participantIds` is only
 * the "who has engaged" set, used for presence and notification fan-out.
 */
@Schema({ collection: 'chats', timestamps: true })
export class Chat {
  _id!: Types.ObjectId;

  @Prop({ type: String, enum: Object.values(ChatType), required: true })
  type!: ChatType;

  /** The wishlist id or group-gift id this chat belongs to. */
  @Prop({ type: SchemaTypes.ObjectId, required: true })
  refId!: Types.ObjectId;

  @Prop({ type: [SchemaTypes.ObjectId], ref: 'User', default: [] })
  participantIds!: Types.ObjectId[];

  @Prop({ type: Date, default: null })
  lastMessageAt!: Date | null;

  @Prop({ type: ChatSettingsSchema, default: () => ({}) })
  settings!: ChatSettings;

  createdAt!: Date;
  updatedAt!: Date;
}

export const ChatSchema = SchemaFactory.createForClass(Chat);

// One chat per (wishlist|group_gift, id). The unique index makes get-or-create safe.
ChatSchema.index({ type: 1, refId: 1 }, { unique: true });
// "My chats" — the two dashboard sections.
ChatSchema.index({ participantIds: 1, lastMessageAt: -1 });
