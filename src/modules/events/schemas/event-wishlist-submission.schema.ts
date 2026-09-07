import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { SchemaTypes, Types, type HydratedDocument } from 'mongoose';

export enum EventWishlistSubmissionStatus {
  PENDING = 'pending',
  APPROVED = 'approved',
  REJECTED = 'rejected',
  /** Taken down after approval — by the host, or withdrawn by the owner. */
  REMOVED = 'removed',
}

/**
 * A guest offering their own wishlist to an event they were invited to.
 *
 * Its own record rather than a flag on the wishlist, because the offer exists
 * before the answer: the host has to approve it, and a rejected or withdrawn
 * offer must leave no trace on the list itself.
 *
 * On approval the wishlist is linked to the event — `eventId` set — and that
 * is all. Its visibility stays the owner's: a private list shows on the
 * invitation as a locked row, not as something the approval opened.
 */
@Schema({ timestamps: true, collection: 'event_wishlist_submissions' })
export class EventWishlistSubmission {
  _id!: Types.ObjectId;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'Event', required: true, index: true })
  eventId!: Types.ObjectId;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'Wishlist', required: true })
  wishlistId!: Types.ObjectId;

  /** The guest who offered it. Always the wishlist's owner. */
  @Prop({ type: SchemaTypes.ObjectId, ref: 'User', required: true, index: true })
  requestedById!: Types.ObjectId;

  @Prop({
    type: String,
    enum: Object.values(EventWishlistSubmissionStatus),
    default: EventWishlistSubmissionStatus.PENDING,
  })
  status!: EventWishlistSubmissionStatus;

  @Prop({ type: Date, default: null })
  respondedAt!: Date | null;

  createdAt!: Date;
  updatedAt!: Date;
}

export type EventWishlistSubmissionDocument = HydratedDocument<EventWishlistSubmission>;

export const EventWishlistSubmissionSchema = SchemaFactory.createForClass(EventWishlistSubmission);

// One offer per list per event: asking twice is the same ask.
EventWishlistSubmissionSchema.index({ eventId: 1, wishlistId: 1 }, { unique: true });

// The host's queue, newest first.
EventWishlistSubmissionSchema.index({ eventId: 1, status: 1, createdAt: -1 });

/**
 * A wishlist belongs to at most one event, so it may have at most one offer
 * outstanding or accepted at a time. Enforced here rather than by a read-then-
 * write check, which two requests can pass at once.
 */
EventWishlistSubmissionSchema.index(
  { wishlistId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      status: {
        $in: [EventWishlistSubmissionStatus.PENDING, EventWishlistSubmissionStatus.APPROVED],
      },
    },
  },
);
