import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes, Types } from 'mongoose';
import { SettlementDirection, SettlementStatus } from '../group-gift.types';

export type SettlementDocument = HydratedDocument<Settlement>;

/**
 * One person's outstanding balance on one group gift.
 *
 * Wishtick never moves money — the host pays a contributor back over UPI, or a
 * contributor tops the host up, entirely outside the app. The design says so in
 * as many words (`4099:976`: *"You are sending refund of ₹333 to each
 * contributor **outside Wishtick**. Once sent, mark each refund as 'Sent'."*).
 *
 * So this is a **ledger of promises**, not of transactions. Its whole job is to
 * answer "who still owes whom, and has each side said it happened" — which is
 * exactly the two-sided confirmation the frames draw: the host marks *sent*, the
 * contributor confirms *received*.
 *
 * Both marks are recorded separately and neither implies the other. A host who
 * marks something sent has made a claim, not proved a payment; only the
 * contributor's confirmation closes it. Collapsing the two would let one party
 * silently settle the other's balance.
 */
@Schema({ collection: 'settlements', timestamps: true })
export class Settlement {
  _id!: Types.ObjectId;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'GroupGift', required: true })
  groupGiftId!: Types.ObjectId;

  /** The person on the far side of the host. */
  @Prop({ type: SchemaTypes.ObjectId, ref: 'User', required: true })
  contributorId!: Types.ObjectId;

  /**
   * The group's initiator, denormalized from the parent.
   *
   * Every permission check on this row — who may mark sent, who may confirm,
   * who may share a UPI ID — is "host or contributor", so carrying the host
   * here makes authorization a single read instead of loading the group gift
   * on each call. It is immutable for the life of a group gift, so there is
   * nothing to keep in sync.
   */
  @Prop({ type: SchemaTypes.ObjectId, ref: 'User', required: true })
  hostId!: Types.ObjectId;

  /**
   * Who owes whom.
   *
   * `return` — the group over-collected and the host pays the contributor back.
   * `top_up` — the gift cost more than was pledged and the contributor owes the
   * host. The frames call the first "refund"; the ledger avoids that word
   * because no card is ever reversed.
   */
  @Prop({ type: String, enum: Object.values(SettlementDirection), required: true })
  direction!: SettlementDirection;

  /** Integer minor units, always positive — `direction` carries the sign. */
  @Prop({ type: Number, required: true })
  amountMinor!: number;

  @Prop({ type: String, default: 'INR', uppercase: true })
  currency!: string;

  @Prop({
    type: String,
    enum: Object.values(SettlementStatus),
    default: SettlementStatus.PENDING,
  })
  status!: SettlementStatus;

  /**
   * The UPI ID as it stood when this settlement was raised.
   *
   * Copied, not referenced: a contributor editing their saved UPI ID months
   * later must not rewrite what the host was told to pay. Null until they share
   * one — which is the state `4099:1199` renders as "Not Added".
   */
  @Prop({ type: String, default: null })
  upiId!: string | null;

  /** When the payer said they sent it. A claim, not proof. */
  @Prop({ type: Date, default: null })
  sentAt!: Date | null;

  /** When the receiver confirmed it landed. This is what closes the row. */
  @Prop({ type: Date, default: null })
  confirmedAt!: Date | null;

  /** The host's note on a contribution request — `4092:174`'s message field. */
  @Prop({ type: String, default: null, maxlength: 280 })
  note!: string | null;

  createdAt!: Date;
  updatedAt!: Date;
}

export const SettlementSchema = SchemaFactory.createForClass(Settlement);

// One open settlement per person per gift per direction: raising a second
// return for someone who already has one would double what the host is told to
// pay. A new round is only legal once the previous is confirmed — enforced in
// the service, with this index as the backstop.
SettlementSchema.index(
  { groupGiftId: 1, contributorId: 1, direction: 1, status: 1 },
  {
    unique: true,
    partialFilterExpression: {
      status: { $in: [SettlementStatus.PENDING, SettlementStatus.SENT] },
    },
  },
);
// The host's progress list (`4099:976`) and the participant projection.
SettlementSchema.index({ groupGiftId: 1, direction: 1 });
// "What do I owe / what am I owed" across every gift — the contributor's view.
SettlementSchema.index({ contributorId: 1, status: 1, createdAt: -1 });
