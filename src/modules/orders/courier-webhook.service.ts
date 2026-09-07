import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { AppException } from 'src/common/errors/app.exception';
import { ErrorCode } from 'src/common/errors/error-codes';
import type { AppConfig } from 'src/config/configuration';
import { OrderStage, OrderStageSource } from './order.types';
import { OrdersService } from './orders.service';
import type { CourierWebhookDto } from './dto/courier-webhook.dto';

export interface CourierWebhookResult {
  /** False when the event named an order we do not have. */
  matched: boolean;
  reference: string;
  stage: OrderStage | null;
}

/**
 * Groundwork for a carrier feed.
 *
 * Nothing calls this yet — Wishtick has no logistics contract, and buyers
 * currently purchase at the merchant through the affiliate redirect. It exists
 * so onboarding a courier is configuration plus a mapping, rather than a
 * schema change and a migration. Every field it writes is one the Track Order
 * screen already renders as "unknown" while null.
 *
 * Signature verification is deliberately a copy of the affiliate webhook's
 * rather than a shared helper: the two have separate secrets, separate
 * rotation schedules and separate vendors, and coupling them would mean
 * rotating a courier key could break affiliate conversions.
 */
@Injectable()
export class CourierWebhookService {
  private readonly logger = new Logger(CourierWebhookService.name);

  constructor(
    private readonly config: ConfigService<AppConfig, true>,
    private readonly orders: OrdersService,
  ) {}

  /**
   * Three mandatory checks, for the same reasons the affiliate webhook gives:
   * an unknown provider cannot be verified, the HMAC must cover the exact
   * bytes received, and the signed timestamp is what stops a captured request
   * being replayed forever.
   */
  verifySignature(provider: string, rawBody: Buffer, signature: string, timestamp: string): void {
    const secret = this.config.get('orders.courierWebhookSecrets', { infer: true })[provider];
    if (!secret) {
      throw new AppException(
        ErrorCode.WEBHOOK_PROVIDER_UNKNOWN,
        'Unknown or unconfigured courier',
        404,
      );
    }

    const ts = Number(timestamp);
    const toleranceMs =
      this.config.get('orders.courierWebhookToleranceSeconds', { infer: true }) * 1_000;
    if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > toleranceMs) {
      throw new AppException(
        ErrorCode.WEBHOOK_TIMESTAMP_INVALID,
        'Webhook timestamp is missing, malformed, or outside the tolerance window',
        400,
      );
    }

    const expected = createHmac('sha256', secret).update(`${timestamp}.`).update(rawBody).digest();
    const provided = Buffer.from(signature, 'hex');

    // timingSafeEqual, not `===`: a short-circuiting compare leaks the
    // signature one byte at a time.
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      throw new AppException(
        ErrorCode.WEBHOOK_SIGNATURE_INVALID,
        'Webhook signature verification failed',
        401,
      );
    }
  }

  /**
   * Applies a verified event to the order it names.
   *
   * An unmatched reference is reported, not thrown: couriers retry on any
   * non-2xx, and a 404 for an order that will never exist would retry forever.
   */
  async apply(provider: string, dto: CourierWebhookDto): Promise<CourierWebhookResult> {
    const order = await this.orders.findByReference(dto.reference);
    if (!order) {
      this.logger.warn(`Courier '${provider}' referenced unknown order ${dto.reference}`);
      return { matched: false, reference: dto.reference, stage: null };
    }

    const updated = await this.orders.advance(order._id, {
      stage: dto.stage,
      source: OrderStageSource.COURIER_WEBHOOK,
      at: dto.occurredAt ? new Date(dto.occurredAt) : undefined,
      note: dto.note ?? null,
      courier: dto.courier ?? provider,
      trackingNumber: dto.trackingNumber,
      trackingUrl: dto.trackingUrl,
      deliveryMethod: dto.deliveryMethod,
      estimatedDeliveryFrom: dto.estimatedDeliveryFrom
        ? new Date(dto.estimatedDeliveryFrom)
        : undefined,
      estimatedDeliveryTo: dto.estimatedDeliveryTo ? new Date(dto.estimatedDeliveryTo) : undefined,
    });

    return {
      matched: true,
      reference: dto.reference,
      stage: updated?.stage ?? null,
    };
  }
}
