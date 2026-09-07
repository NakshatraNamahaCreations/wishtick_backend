import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes, Types } from 'mongoose';
import { MessageKind, SystemMessageType } from '../chat.types';

export type MessageDocument = HydratedDocument<Message>;

@Schema({ _id: false })
export class MessageReaction {
  @Prop({ type: String, required: true })
  emoji!: string;

  @Prop({ type: [SchemaTypes.ObjectId], ref: 'User', default: [] })
  userIds!: Types.ObjectId[];
}

export const MessageReactionSchema = SchemaFactory.createForClass(MessageReaction);

@Schema({ _id: false })
export class MessageAttachment {
  @Prop({ type: SchemaTypes.ObjectId, ref: 'Media', required: true })
  mediaId!: Types.ObjectId;

  @Prop({ type: String, default: null })
  url!: string | null;

  @Prop({ type: String, default: null })
  contentType!: string | null;
}

export const MessageAttachmentSchema = SchemaFactory.createForClass(MessageAttachment);

@Schema({ collection: 'messages', timestamps: true })
export class Message {
  _id!: Types.ObjectId;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'Chat', required: true })
  chatId!: Types.ObjectId;

  /** Null for a system message. */
  @Prop({ type: SchemaTypes.ObjectId, ref: 'User', default: null })
  senderId!: Types.ObjectId | null;

  @Prop({ type: String, enum: Object.values(MessageKind), default: MessageKind.TEXT })
  kind!: MessageKind;

  @Prop({ type: String, default: '', maxlength: 4000 })
  body!: string;

  @Prop({ type: [MessageAttachmentSchema], default: [] })
  attachments!: MessageAttachment[];

  @Prop({ type: SchemaTypes.ObjectId, ref: 'Message', default: null })
  replyToId!: Types.ObjectId | null;

  @Prop({ type: [MessageReactionSchema], default: [] })
  reactions!: MessageReaction[];

  @Prop({ type: Date, default: null })
  editedAt!: Date | null;

  /** Soft delete: the row stays so replies and history do not dangle. */
  @Prop({ type: Date, default: null })
  deletedAt!: Date | null;

  @Prop({ type: String, enum: Object.values(SystemMessageType), default: null })
  systemType!: SystemMessageType | null;

  /** Structured data a client localizes from, instead of parsing the body string. */
  @Prop({ type: SchemaTypes.Mixed, default: null })
  systemPayload!: Record<string, unknown> | null;

  /**
   * Users this message must never reach — the anti-spoiler control.
   *
   * A message about a surprise gift carries the recipient here; the history
   * projection filters them out and the socket broadcast excludes their personal
   * room, so the owner cannot see it through *any* path.
   */
  @Prop({ type: [SchemaTypes.ObjectId], ref: 'User', default: [] })
  hideFromUserIds!: Types.ObjectId[];

  /**
   * Deduplication key for a system message, globally unique when set.
   *
   * Derived from the source event (e.g. `gg_funded:{groupGiftId}`), so a
   * redelivered or retried event inserts the same key and the unique index
   * rejects the second — exactly-once, the same durable-dedupe pattern as the
   * affiliate webhook. Left UNSET for human messages, which are never deduped —
   * the index below only covers string keys, so absent/null values do not
   * collide with each other.
   */
  @Prop({ type: String })
  dedupeKey?: string;

  createdAt!: Date;
  updatedAt!: Date;
}

export const MessageSchema = SchemaFactory.createForClass(Message);

// Cursor pagination walks (chatId, _id) descending — _id is monotonic, so it is
// insertion order without a separate sort key.
MessageSchema.index({ chatId: 1, _id: -1 });
// Exactly-once for system messages. Partial (not sparse) so it indexes ONLY
// string keys: a sparse index still indexes an explicit `null`, which would make
// every keyless human message collide on null. This covers just real keys.
MessageSchema.index(
  { dedupeKey: 1 },
  { unique: true, partialFilterExpression: { dedupeKey: { $type: 'string' } } },
);
