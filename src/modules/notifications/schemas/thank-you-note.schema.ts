import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes, Types } from 'mongoose';

export type ThankYouNoteDocument = HydratedDocument<ThankYouNote>;

/**
 * What the recipient actually recorded.
 *
 * The note always carries a subject and body — the email that reaches the
 * gifter is text, and a mail client cannot play a voice note. A non-text kind
 * *adds* an attachment the in-app view plays; it does not replace the words.
 */
export enum ThankYouKind {
  TEXT = 'text',
  PHOTO = 'photo',
  AUDIO = 'audio',
  VIDEO = 'video',
}

/** The kinds that require [ThankYouNote.mediaId] to be set. */
export const THANK_YOU_KINDS_WITH_MEDIA = [
  ThankYouKind.PHOTO,
  ThankYouKind.AUDIO,
  ThankYouKind.VIDEO,
];

export enum ThankYouStatus {
  /** Auto-send is off for the author; waiting for a manual send. */
  DRAFT = 'draft',
  /** A delayed job will send it unless the author edits/skips first. */
  SCHEDULED = 'scheduled',
  SENT = 'sent',
  SKIPPED = 'skipped',
}

/** Denormalized at creation so the note renders without re-reading four collections. */
@Schema({ _id: false })
export class ThankYouContext {
  @Prop({ type: String, required: true })
  recipientName!: string;

  @Prop({ type: String, required: true })
  gifterName!: string;

  @Prop({ type: String, default: null })
  itemTitle!: string | null;

  @Prop({ type: String, default: null })
  eventTitle!: string | null;

  @Prop({ type: Date, default: null })
  eventDate!: Date | null;
}

export const ThankYouContextSchema = SchemaFactory.createForClass(ThankYouContext);

/**
 * A thank-you note the gift's recipient sends to the gifter.
 *
 * Created (once — `giftId` is unique) when a gift is fulfilled, with a delayed
 * job to auto-send after the configured delay. The recipient owns it: they can
 * preview, edit the body, send it now, or skip it. It never sends without their
 * consent (auto-send preference) and goes to the gifter's email subject to the
 * gifter's own suppression/consent.
 */
@Schema({ collection: 'thank_you_notes', timestamps: true })
export class ThankYouNote {
  _id!: Types.ObjectId;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'Gift', required: true, unique: true })
  giftId!: Types.ObjectId;

  /** The wishlist owner — the note's author and the only one who may edit it. */
  @Prop({ type: SchemaTypes.ObjectId, ref: 'User', required: true })
  recipientId!: Types.ObjectId;

  /** The gifter — the note's addressee. */
  @Prop({ type: SchemaTypes.ObjectId, ref: 'User', required: true })
  gifterId!: Types.ObjectId;

  @Prop({ type: ThankYouContextSchema, required: true })
  context!: ThankYouContext;

  @Prop({ type: String, required: true, maxlength: 200 })
  subject!: string;

  @Prop({ type: String, required: true, maxlength: 2000 })
  body!: string;

  @Prop({ type: String, enum: Object.values(ThankYouKind), default: ThankYouKind.TEXT })
  kind!: ThankYouKind;

  /** The recorded photo/voice note/video, when [kind] is not text. */
  @Prop({ type: SchemaTypes.ObjectId, ref: 'Media', default: null })
  mediaId!: Types.ObjectId | null;

  /** Denormalized at attach time so rendering a note reads one document. */
  @Prop({ type: String, default: null })
  mediaUrl!: string | null;

  @Prop({ type: String, enum: Object.values(ThankYouStatus), default: ThankYouStatus.SCHEDULED })
  status!: ThankYouStatus;

  @Prop({ type: Date, default: null })
  scheduledFor!: Date | null;

  @Prop({ type: Date, default: null })
  sentAt!: Date | null;

  @Prop({ type: Date, default: null })
  editedAt!: Date | null;

  createdAt!: Date;
  updatedAt!: Date;
}

export const ThankYouNoteSchema = SchemaFactory.createForClass(ThankYouNote);

// giftId already unique via @Prop. The author's list of notes.
ThankYouNoteSchema.index({ recipientId: 1, createdAt: -1 });
