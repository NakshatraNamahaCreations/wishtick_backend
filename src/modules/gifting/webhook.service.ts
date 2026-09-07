import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { Model } from 'mongoose';
import { AppException } from 'src/common/errors/app.exception';
import { ErrorCode } from 'src/common/errors/error-codes';
import type { AppConfig } from 'src/config/configuration';
import { CacheService } from 'src/infra/redis/cache.service';
import { GiftStatusService } from './gift-status.service';
import { GiftMode, GiftStatus } from './gift.types';
import { Gift, type GiftDocument } from './schemas/gift.schema';
import {
  WebhookEvent,
  WebhookEventStatus,
  type WebhookEventDocument,
} from './schemas/webhook-event.schema';

/**
 * A provider event, normalized. Real adapters map each network's payload shape
 * onto this; the fixture provider (and tests) speak it directly.
 */
/** order → purchased, shipment → fulfilled; anything else is treated as order. */
export type WebhookEventType = 'order' | 'shipment' | (string & {});

export interface NormalizedWebhookEvent {
  providerEventId: string;
  eventType: WebhookEventType;
  /** The subId we stamped on the outbound click, echoed back. */
  orderRef: string;
  timestamp: number;
}

export interface WebhookResult {
  status: WebhookEventStatus;
  giftId?: string;
  reason?: string;
}

/** The auto-tick nonce lives just long enough to catch a fast replay. */
const NONCE_TTL_SECONDS = 24 * 60 * 60;

@Injectable()
export class WebhookService {
  private readonly logger = new Logger(WebhookService.name);

  constructor(
    @InjectModel(Gift.name) private readonly giftModel: Model<GiftDocument>,
    @InjectModel(WebhookEvent.name) private readonly events: Model<WebhookEventDocument>,
    private readonly status: GiftStatusService,
    private readonly cache: CacheService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  /**
   * Verifies a webhook's authenticity before we trust a byte of it.
   *
   * Three checks, all mandatory, because this endpoint moves gift state and is
   * reachable from the internet:
   *
   *  - **Unknown provider → reject.** No configured secret means we cannot
   *    verify anything; accepting would be trusting an unsigned request.
   *  - **HMAC over the raw body.** The signature must be computed on the exact
   *    bytes received (not a re-serialized object), or a re-encode changes the
   *    digest and every real webhook fails.
   *  - **Timestamp window.** A valid signature is replayable forever without
   *    this: an attacker who captures one request could resend it any time. The
   *    signed timestamp bounds that to a few minutes of clock skew.
   *
   * timingSafeEqual, not `===`: string comparison short-circuits on the first
   * differing byte and leaks the signature one character at a time.
   */
  verifySignature(provider: string, rawBody: Buffer, signature: string, timestamp: string): void {
    const secret = this.config.get('gifting.webhookSecrets', { infer: true })[provider];
    if (!secret) {
      throw new AppException(
        ErrorCode.WEBHOOK_PROVIDER_UNKNOWN,
        'Unknown or unconfigured webhook provider',
        404,
      );
    }

    const ts = Number(timestamp);
    const toleranceMs = this.config.get('gifting.webhookToleranceSeconds', { infer: true }) * 1_000;
    if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > toleranceMs) {
      throw new AppException(
        ErrorCode.WEBHOOK_TIMESTAMP_INVALID,
        'Webhook timestamp is missing, malformed, or outside the tolerance window',
        400,
      );
    }

    // Sign timestamp + body together, so the timestamp itself is covered and
    // cannot be swapped for a fresh one while keeping an old body's signature.
    const expected = createHmac('sha256', secret).update(`${timestamp}.`).update(rawBody).digest();
    const provided = Buffer.from(signature, 'hex');

    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      throw new AppException(
        ErrorCode.WEBHOOK_SIGNATURE_INVALID,
        'Webhook signature verification failed',
        401,
      );
    }
  }

  /**
   * Applies a verified event to the matching gift. Idempotent and durable.
   *
   * The flow, and why each step is where it is:
   *
   *  1. **Fast replay guard (Redis nonce).** A SET NX on the provider event id.
   *     The provider WILL redeliver — treating a redelivery as a fresh purchase
   *     would tick a gift twice. This catches the common case in one round trip.
   *
   *  2. **Durable dedupe (unique index).** The nonce expires; the
   *     webhook_events row does not. Its unique (provider, providerEventId)
   *     index is the lasting guarantee that one event is applied once, even a
   *     day later.
   *
   *  3. **Match by orderRef → apply.** order → purchased, shipment → fulfilled.
   *     Out-of-order is handled by the state machine: a shipment arriving before
   *     the order still lands the gift at fulfilled, because fulfilled is
   *     reachable and re-applying a status is a no-op.
   *
   *  4. **No match → dead-letter, never drop.** A signature-valid event that
   *     matches no gift is stored `unmatched` for admin review. It usually means
   *     the conversion beat our reservation write; silently discarding it would
   *     lose a real purchase signal.
   */
  async process(provider: string, event: NormalizedWebhookEvent): Promise<WebhookResult> {
    // 1. Fast replay guard.
    const nonceKey = `webhook:nonce:${provider}:${event.providerEventId}`;
    const fresh = await this.cache.client.set(nonceKey, '1', 'EX', NONCE_TTL_SECONDS, 'NX');
    if (fresh !== 'OK') {
      this.logger.log(`Webhook ${provider}/${event.providerEventId} is a replay (nonce hit)`);
      return { status: WebhookEventStatus.DUPLICATE, reason: 'nonce' };
    }

    // 2. Durable dedupe: claim the event row. A racing duplicate that slipped
    // past the nonce is caught here.
    let record: WebhookEventDocument;
    try {
      record = await this.events.create({
        provider,
        providerEventId: event.providerEventId,
        eventType: event.eventType,
        orderRef: event.orderRef,
        status: WebhookEventStatus.UNMATCHED,
        payload: event as unknown as Record<string, unknown>,
      });
    } catch (err) {
      if (WebhookService.isDuplicateKey(err)) {
        return { status: WebhookEventStatus.DUPLICATE, reason: 'already-recorded' };
      }
      throw err;
    }

    // 3. Match and apply.
    const gift = await this.giftModel
      .findOne({ orderRef: event.orderRef, mode: GiftMode.ONLINE, active: true })
      .exec();

    if (!gift) {
      // 4. Dead-letter. The conversion may have beaten our reservation; a human
      // (or a later re-match) can reconcile it.
      await this.events.updateOne(
        { _id: record._id },
        { $set: { note: 'no active online gift matched this orderRef' } },
      );
      this.logger.warn(
        `Webhook ${provider}/${event.providerEventId} matched no gift (orderRef ${event.orderRef}); dead-lettered`,
      );
      return { status: WebhookEventStatus.UNMATCHED, reason: 'no-match' };
    }

    const target = event.eventType === 'shipment' ? GiftStatus.FULFILLED : GiftStatus.PURCHASED;

    try {
      // A shipment for a still-reserved gift means the order event was lost or
      // arrived out of order. The shipment itself proves the purchase happened,
      // so walk through `purchased` rather than jumping the state machine: this
      // keeps the canonical reserved → purchased → fulfilled path (and
      // purchasedAt) intact, and is how out-of-order events converge — a later
      // order event then finds the gift already past purchased and no-ops.
      if (target === GiftStatus.FULFILLED && gift.status === GiftStatus.RESERVED) {
        await this.status.transition(gift, GiftStatus.PURCHASED, `system:webhook:${provider}`, {
          note: `implied purchase from shipment event ${event.providerEventId}`,
        });
      }

      await this.status.transition(gift, target, `system:webhook:${provider}`, {
        note: `auto-ticked from ${event.eventType} event ${event.providerEventId}`,
      });
    } catch (err) {
      if (err instanceof AppException && err.errorCode === ErrorCode.INVALID_GIFT_TRANSITION) {
        // e.g. a purchase event for an already-fulfilled gift (redelivery /
        // reordering). Not a failure — record it and move on rather than 500.
        await this.events.updateOne(
          { _id: record._id },
          {
            $set: {
              status: WebhookEventStatus.PROCESSED,
              matchedGiftId: gift._id,
              note: `no-op: gift already ${gift.status}`,
            },
          },
        );
        return {
          status: WebhookEventStatus.PROCESSED,
          giftId: gift._id.toString(),
          reason: 'already-applied',
        };
      }
      throw err;
    }

    await this.events.updateOne(
      { _id: record._id },
      { $set: { status: WebhookEventStatus.PROCESSED, matchedGiftId: gift._id } },
    );

    this.logger.log(
      `Webhook ${provider}/${event.providerEventId} → gift ${gift._id.toString()} ${target}`,
    );
    return { status: WebhookEventStatus.PROCESSED, giftId: gift._id.toString() };
  }

  /** The admin dead-letter view: signature-valid events that matched no gift. */
  async listDeadLettered(limit = 100): Promise<WebhookEventDocument[]> {
    return this.events
      .find({ status: WebhookEventStatus.UNMATCHED })
      .sort({ createdAt: -1 })
      .limit(limit)
      .exec();
  }

  private static isDuplicateKey(err: unknown): boolean {
    return (err as { code?: number })?.code === 11000;
  }

  /** Test/dev helper: compute the signature a provider would send. */
  static sign(secret: string, timestamp: number, rawBody: Buffer): string {
    return createHmac('sha256', secret).update(`${timestamp}.`).update(rawBody).digest('hex');
  }
}
