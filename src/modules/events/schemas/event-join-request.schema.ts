import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { SchemaTypes, Types, type HydratedDocument } from 'mongoose';

export enum EventJoinRequestStatus {
  PENDING = 'pending',
  /**
   * Kept, not deleted, so the same person cannot simply ask again: the host
   * answered once, and a second ask is the same ask. It leaves the host's
   * queue the moment it is declined.
   */
  DECLINED = 'declined',
}

/**
 * Somebody who opened a private event's share link without being on its guest
 * list, asking the host to let them in.
 *
 * A private event used to turn them away outright. A link travels — forwarded
 * in a group, passed from the person invited to their partner — and the host
 * is the one who should decide who comes, not the link.
 *
 * Accepting does not change this record: it is deleted, and an ordinary
 * invite is made in its place, so the guest list stays the one record of who
 * is coming. Every request for an event goes once the event has started —
 * there is nothing left to ask to join.
 */
@Schema({ timestamps: true, collection: 'event_join_requests' })
export class EventJoinRequest {
  _id!: Types.ObjectId;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'Event', required: true })
  eventId!: Types.ObjectId;

  /** Who is asking. Always signed in: an ask names a person. */
  @Prop({ type: SchemaTypes.ObjectId, ref: 'User', required: true })
  userId!: Types.ObjectId;

  @Prop({
    type: String,
    enum: Object.values(EventJoinRequestStatus),
    default: EventJoinRequestStatus.PENDING,
  })
  status!: EventJoinRequestStatus;

  @Prop({ type: Date, default: null })
  decidedAt!: Date | null;

  createdAt!: Date;
  updatedAt!: Date;
}

export type EventJoinRequestDocument = HydratedDocument<EventJoinRequest>;

export const EventJoinRequestSchema = SchemaFactory.createForClass(EventJoinRequest);

// One ask per person per event: asking twice is the same ask, and a declined
// one stays to say so.
EventJoinRequestSchema.index({ eventId: 1, userId: 1 }, { unique: true });

// The host's queue, oldest first — first come, first answered.
EventJoinRequestSchema.index({ eventId: 1, status: 1, createdAt: 1 });
