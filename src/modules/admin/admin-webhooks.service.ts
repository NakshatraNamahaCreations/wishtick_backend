import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import {
  WebhookEvent,
  WebhookEventStatus,
  type WebhookEventDocument,
} from 'src/modules/gifting/schemas/webhook-event.schema';
import { findPage, type AdminPage } from './admin-query.util';

export interface WebhookEventAdminView {
  id: string;
  provider: string;
  providerEventId: string;
  eventType: string | null;
  orderRef: string | null;
  status: string;
  matchedGiftId: string | null;
  note: string | null;
  payload: Record<string, unknown>;
  createdAt: Date;
}

/**
 * Inbound webhooks, as an operator sees them.
 *
 * Read straight from `webhook_events` — a borrowed schema, like the rest of
 * what the admin module inspects — rather than through GiftingModule, which
 * would tie the operator plane to the gifting module's wiring.
 */
@Injectable()
export class AdminWebhooksService {
  constructor(
    @InjectModel(WebhookEvent.name) private readonly events: Model<WebhookEventDocument>,
  ) {}

  /**
   * Signature-valid events that matched no gift, newest first. Kept rather than
   * dropped so a sale nobody could place is still found, and placed by hand.
   */
  deadLetter(page?: number, limit?: number): Promise<AdminPage<WebhookEventAdminView>> {
    return findPage<WebhookEventDocument, WebhookEventAdminView>(
      this.events,
      { status: WebhookEventStatus.UNMATCHED },
      { page, limit, view: (e) => AdminWebhooksService.toView(e) },
    );
  }

  static toView(e: WebhookEventDocument): WebhookEventAdminView {
    const withTime = e;
    return {
      id: e._id.toString(),
      provider: e.provider,
      providerEventId: e.providerEventId,
      eventType: e.eventType ?? null,
      orderRef: e.orderRef ?? null,
      status: e.status,
      matchedGiftId: e.matchedGiftId?.toString() ?? null,
      note: e.note ?? null,
      payload: e.payload ?? {},
      createdAt: withTime.createdAt,
    };
  }
}
