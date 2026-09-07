import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes, Types } from 'mongoose';
import { OrderStage, OrderStageSource } from '../order.types';

@Schema({ _id: false })
export class OrderStageEntry {
  @Prop({ type: String, enum: Object.values(OrderStage), required: true })
  stage!: OrderStage;

  @Prop({ type: Date, required: true })
  at!: Date;

  @Prop({ type: String, enum: Object.values(OrderStageSource), required: true })
  source!: OrderStageSource;

  @Prop({ type: String, default: null, maxlength: 500 })
  note!: string | null;
}

export const OrderStageEntrySchema = SchemaFactory.createForClass(OrderStageEntry);

export type OrderDocument = HydratedDocument<Order>;

/**
 * The trackable shell around a purchased gift (Figma `299:1486` / `299:1513`).
 *
 * One order per online gift, created when the gift reaches `purchased`. Offline
 * gifts get none, deliberately — `GiftMode.OFFLINE` is documented as "bought
 * elsewhere; there is no order to track", and minting an empty order for one
 * would put a Track Order button on something we can never track.
 *
 * The carrier fields below are nullable by design. Wishtick sends buyers to the
 * merchant through the affiliate redirect and has no logistics feed, so nothing
 * fills them today; they exist so a courier integration is a write, not a
 * migration. Anything null must render as unknown rather than as a guess.
 */
@Schema({ collection: 'orders', timestamps: true })
export class Order {
  _id!: Types.ObjectId;

  /** One order per gift; the unique index makes that an invariant. */
  @Prop({ type: SchemaTypes.ObjectId, ref: 'Gift', required: true })
  giftId!: Types.ObjectId;

  /** Denormalized so "my orders" is one query rather than a join. */
  @Prop({ type: SchemaTypes.ObjectId, ref: 'User', required: true })
  gifterId!: Types.ObjectId;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'WishlistItem', required: true })
  itemId!: Types.ObjectId;

  /**
   * The human-facing id the confirmation screen shows — `WTK-20260714-1989`.
   * Not the primary key: an ObjectId is unguessable and this is not, so this is
   * for reading aloud to support, never for authorization.
   *
   * Uniqueness is declared once, on the explicit index below — `unique: true`
   * here as well would have Mongoose build the same index twice and warn.
   */
  @Prop({ type: String, required: true })
  reference!: string;

  @Prop({
    type: String,
    enum: Object.values(OrderStage),
    default: OrderStage.ORDER_CONFIRMED,
  })
  stage!: OrderStage;

  @Prop({ type: [OrderStageEntrySchema], default: [] })
  timeline!: OrderStageEntry[];

  /** Snapshot of what was paid, in minor units. Display only — see Gift. */
  @Prop({ type: Number, default: null })
  amountMinor!: number | null;

  @Prop({ type: String, default: 'INR', uppercase: true })
  currency!: string;

  // ── Carrier, all unpopulated until a logistics integration exists ────────

  /** e.g. "Delhivery". Null while unknown. */
  @Prop({ type: String, default: null, maxlength: 120 })
  courier!: string | null;

  /** The carrier's own consignment number. */
  @Prop({ type: String, default: null, maxlength: 120 })
  trackingNumber!: string | null;

  /** Where the buyer can follow it on the carrier's site. */
  @Prop({ type: String, default: null, maxlength: 2048 })
  trackingUrl!: string | null;

  /** "Standard Delivery" / "Express". Free text from the carrier. */
  @Prop({ type: String, default: null, maxlength: 120 })
  deliveryMethod!: string | null;

  /** Start of the promised window. */
  @Prop({ type: Date, default: null })
  estimatedDeliveryFrom!: Date | null;

  /** End of the promised window; equal to `from` for a single-day estimate. */
  @Prop({ type: Date, default: null })
  estimatedDeliveryTo!: Date | null;

  @Prop({ type: Date, default: null })
  deliveredAt!: Date | null;

  createdAt!: Date;
  updatedAt!: Date;
}

export const OrderSchema = SchemaFactory.createForClass(Order);

// One order per gift. Unique rather than merely indexed so a double-purchase
// race cannot mint two orders for the same gift.
OrderSchema.index({ giftId: 1 }, { unique: true });
OrderSchema.index({ reference: 1 }, { unique: true });
OrderSchema.index({ gifterId: 1, createdAt: -1 });
