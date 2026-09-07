import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes, Types } from 'mongoose';

export type WebhookEventDocument = HydratedDocument<WebhookEvent>;

export enum WebhookEventStatus {
  /** Matched a gift and applied. */
  PROCESSED = 'processed',
  /** Signature-valid but matched no gift. Held for admin review, never dropped. */
  UNMATCHED = 'unmatched',
  /** A duplicate of one we already handled (same provider event id). */
  DUPLICATE = 'duplicate',
  /** Understood the shape but could not act on it. */
  FAILED = 'failed',
}

/**
 * The durable record of every accepted webhook.
 *
 * Two jobs, both non-negotiable for a money-adjacent integration:
 *
 *  1. **Idempotency / replay defence.** The unique index on
 *     (provider, providerEventId) means the same event applied twice is a
 *     no-op — the provider WILL redeliver, and a conversion counted twice is
 *     a real problem. (A short-lived Redis nonce catches replays fast; this
 *     collection is the durable backstop that outlives the nonce's TTL.)
 *
 *  2. **A dead-letter queue.** A signature-valid event that matches no gift is
 *     stored `unmatched` rather than dropped: it usually means a race (the
 *     conversion beat our reservation write, or an order we never saw), and a
 *     human needs to be able to find it. Silently discarding a real purchase
 *     signal is how a gifter's order never gets ticked.
 */
@Schema({ collection: 'webhook_events', timestamps: true })
export class WebhookEvent {
  _id!: Types.ObjectId;

  @Prop({ type: String, required: true })
  provider!: string;

  /** The provider's own event id — the key we dedupe on. */
  @Prop({ type: String, required: true })
  providerEventId!: string;

  @Prop({ type: String, default: null })
  eventType!: string | null;

  /** The order/tracking ref carried in the payload; how we find the gift. */
  @Prop({ type: String, default: null })
  orderRef!: string | null;

  @Prop({ type: String, enum: Object.values(WebhookEventStatus), required: true })
  status!: WebhookEventStatus;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'Gift', default: null })
  matchedGiftId!: Types.ObjectId | null;

  /** The verbatim payload, for replaying against a gift that arrives late. */
  @Prop({ type: Object, default: {} })
  payload!: Record<string, unknown>;

  @Prop({ type: String, default: null })
  note!: string | null;

  createdAt!: Date;
  updatedAt!: Date;
}

export const WebhookEventSchema = SchemaFactory.createForClass(WebhookEvent);

// Dedupe key: the same provider event, however many times it is delivered, is
// one row.
WebhookEventSchema.index({ provider: 1, providerEventId: 1 }, { unique: true });
// The admin dead-letter view: unmatched events, newest first.
WebhookEventSchema.index({ status: 1, createdAt: -1 });
// Re-matching a late gift: find unmatched events by the ref they carried.
WebhookEventSchema.index({ orderRef: 1 }, { sparse: true });
