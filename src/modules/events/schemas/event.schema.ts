import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes, Types } from 'mongoose';
import { EventStatus, EventType, EventVisibility } from '../event.types';

export type EventDocument = HydratedDocument<Event>;

@Schema({ _id: false })
export class InviteTemplateChoice {
  @Prop({ type: String, required: true })
  templateId!: string;

  @Prop({ type: String, required: true })
  colorVariant!: string;

  /** Host-supplied copy for the template's slots (headline, subtitle, …). */
  @Prop({ type: Object, default: {} })
  fields!: Record<string, string>;
}

export const InviteTemplateChoiceSchema = SchemaFactory.createForClass(InviteTemplateChoice);

@Schema({ collection: 'events', timestamps: true })
export class Event {
  _id!: Types.ObjectId;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'User', required: true })
  hostId!: Types.ObjectId;

  @Prop({ type: String, required: true, trim: true, maxlength: 140 })
  title!: string;

  @Prop({ type: String, enum: Object.values(EventType), required: true })
  type!: EventType;

  /**
   * The instant the event starts, in UTC.
   *
   * `timezone` is stored beside it rather than derived: "7pm" means 7pm where
   * the party is, and reminders ("your event is tomorrow") must be worded and
   * timed against the host's local clock, not the server's. A UTC instant alone
   * cannot answer "what day is this event on?" for anyone.
   */
  @Prop({ type: Date, required: true })
  startsAt!: Date;

  @Prop({ type: Date, default: null })
  endsAt!: Date | null;

  @Prop({ type: String, default: 'UTC' })
  timezone!: string;

  @Prop({ type: String, default: null, trim: true, maxlength: 2000 })
  description!: string | null;

  /**
   * Where it is happening — the required Location field on `257:755`.
   *
   * Free text, not a place id: the design asks for "Mysore Socials", and
   * demanding a geocoded address for a birthday at someone's flat would be
   * worse than useless. It reaches the invitee, which is the whole point —
   * before this, an invitation showed a time and no place.
   */
  @Prop({ type: String, default: null, trim: true, maxlength: 200 })
  venue!: string | null;

  /**
   * Who the event is for, and how the host knows them — the two required
   * fields on `257:733`.
   *
   * The same pair an ImportantDate already carries. Kept on the event rather
   * than inferred from the title because "Rahul & Priya's Anniversary" does
   * not tell a reminder, an invite card, or the guest list who to name.
   */
  @Prop({ type: String, default: null, trim: true, maxlength: 120 })
  personName!: string | null;

  /** A `relation` taxonomy key (`2252:423`), not free text. */
  @Prop({ type: String, default: null, trim: true, maxlength: 60 })
  relation!: string | null;

  /**
   * The host is the person the event is for — their own birthday, wedding,
   * housewarming.
   *
   * A flag rather than "personName and relation are both null", because a
   * draft that has not been filled in yet looks exactly the same, and the
   * invitation has to know the difference: a card for someone else carries a
   * "Hosted by" line, and a card for the host does not.
   */
  @Prop({ type: Boolean, default: false })
  forSelf!: boolean;

  @Prop({ type: String, default: null })
  coverUrl!: string | null;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'Media', default: null })
  coverMediaId!: Types.ObjectId | null;

  /**
   * The host's own invitation artwork (`2248:70`), uploaded instead of designed
   * from a template.
   *
   * Separate from the cover: a cover decorates the event, this *is* the
   * invitation. When set it wins over `inviteTemplate` on the invitee's screen
   * — the host picked one path or the other, and showing both would be two
   * invitations to the same party.
   */
  @Prop({ type: String, default: null })
  inviteMediaUrl!: string | null;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'Media', default: null })
  inviteMediaId!: Types.ObjectId | null;

  @Prop({
    type: String,
    enum: Object.values(EventVisibility),
    default: EventVisibility.PRIVATE,
  })
  visibility!: EventVisibility;

  /** Wishlists shown on the invite. Host-owned only — see EventsService.link. */
  @Prop({ type: [SchemaTypes.ObjectId], ref: 'Wishlist', default: [] })
  wishlistIds!: Types.ObjectId[];

  /** Sprint 10. */
  @Prop({ type: SchemaTypes.ObjectId, ref: 'ReelCollection', default: null })
  reelCollectionId!: Types.ObjectId | null;

  @Prop({ type: InviteTemplateChoiceSchema, default: null })
  inviteTemplate!: InviteTemplateChoice | null;

  /** Opaque, rotatable. Same reasoning as the wishlist share slug. */
  @Prop({ type: String, required: true })
  shareSlug!: string;

  /** Rasterized share card, produced asynchronously after publish. */
  @Prop({ type: String, default: null })
  ogImageUrl!: string | null;

  @Prop({ type: String, enum: Object.values(EventStatus), default: EventStatus.DRAFT })
  status!: EventStatus;

  @Prop({ type: Date, default: null })
  publishedAt!: Date | null;

  @Prop({ type: Date, default: null })
  cancelledAt!: Date | null;

  createdAt!: Date;
  updatedAt!: Date;
}

export const EventSchema = SchemaFactory.createForClass(Event);

EventSchema.index({ hostId: 1, startsAt: -1 });
EventSchema.index({ shareSlug: 1 }, { unique: true });
// Drives the sweep that marks past events completed.
EventSchema.index({ status: 1, startsAt: 1 });
