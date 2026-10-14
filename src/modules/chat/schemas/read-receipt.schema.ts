import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes, Types } from 'mongoose';

export type ReadReceiptDocument = HydratedDocument<ReadReceipt>;

/**
 * How far a user has read in a chat. Unread counts derive from this — the count
 * of messages after `lastReadMessageId` — so there is no per-message,
 * per-recipient fan-out to maintain.
 */
@Schema({ collection: 'read_receipts', timestamps: true })
export class ReadReceipt {
  _id!: Types.ObjectId;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'Chat', required: true })
  chatId!: Types.ObjectId;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'User', required: true })
  userId!: Types.ObjectId;

  /** The newest message the user has seen; null before they have read anything. */
  @Prop({ type: SchemaTypes.ObjectId, ref: 'Message', default: null })
  lastReadMessageId!: Types.ObjectId | null;

  @Prop({ type: Date, default: null })
  lastReadAt!: Date | null;

  /**
   * "Delete conversation", for this user only: everything up to and including
   * this message is gone from their history and their chat list. The other
   * side keeps every word — one person tidying their inbox must not erase
   * what somebody else wrote. Null until they clear it.
   */
  @Prop({ type: SchemaTypes.ObjectId, ref: 'Message', default: null })
  clearedUpTo!: Types.ObjectId | null;

  createdAt!: Date;
  updatedAt!: Date;
}

export const ReadReceiptSchema = SchemaFactory.createForClass(ReadReceipt);

// One receipt per (chat, user); the upsert on read relies on this being unique.
ReadReceiptSchema.index({ chatId: 1, userId: 1 }, { unique: true });
