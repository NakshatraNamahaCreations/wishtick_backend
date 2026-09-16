import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  AFFILIATE_CONVERSIONS_SYNCED,
  type AffiliateConversionsSyncedEvent,
} from 'src/common/events/domain-events';
import { ProviderGuard, ProviderUnavailableError } from '../providers/provider-guard.service';
import {
  AffiliateSyncState,
  Conversion,
  type AffiliateSyncStateDocument,
  type ConversionDocument,
} from '../schemas/conversion.schema';
import { CuelinksClient, subIdsOf, type CuelinksTransaction } from './cuelinks.client';

export const CONVERSION_SYNC_JOB = 'affiliate-conversion-sync';

/** How many pages one run will pull. A bound, not a target. */
const MAX_PAGES = 20;

/** How far before the last sync to re-ask. See [ConversionSyncService.since]. */
const OVERLAP_MS = 24 * 60 * 60 * 1000;

export interface ConversionSyncReport {
  pages: number;
  transactions: number;
  inserted: number;
  updated: number;
  /** Rows whose sub-IDs matched nothing of ours. Worth watching, not an error. */
  unattributed: number;
}

/**
 * Pulls conversions from the affiliate network and stores them against the item
 * that produced them.
 *
 * Paged, not cursored: Cuelinks answers `{data, meta:{page, next_page, …}}`
 * with no opaque cursor. That has a consequence worth stating — page 1 is
 * always the newest sales, and a *revision* to an old sale (pending →
 * confirmed, or a changed commission) can appear on any page. So this walks
 * from page 1 each run rather than resuming from a stored offset, and relies on
 * the unique `{network, externalId}` index to make re-reads idempotent. It
 * stops early once a whole page contains nothing new, which keeps the steady
 * state at one call.
 *
 * `AffiliateSyncState` therefore records only *when* we last synced, kept
 * because a stalled reconciliation is otherwise invisible.
 */
@Injectable()
export class ConversionSyncService {
  private readonly logger = new Logger(ConversionSyncService.name);
  private readonly network = 'cuelinks';

  constructor(
    @InjectModel(Conversion.name) private readonly conversions: Model<ConversionDocument>,
    @InjectModel(AffiliateSyncState.name)
    private readonly state: Model<AffiliateSyncStateDocument>,
    private readonly cuelinks: CuelinksClient,
    private readonly guard: ProviderGuard,
    private readonly emitter: EventEmitter2,
  ) {}

  async sync(): Promise<ConversionSyncReport> {
    const report: ConversionSyncReport = {
      pages: 0,
      transactions: 0,
      inserted: 0,
      updated: 0,
      unattributed: 0,
    };

    if (!this.cuelinks.enabled) {
      this.logger.debug('Affiliate network disabled — nothing to reconcile');
      return report;
    }

    let page: number | null = 1;
    // Everything revised since the last run, with a day of overlap for rows
    // that landed while it was in flight. Null on the very first run, which
    // takes the API's own default window.
    const updatedSince = await this.since();

    for (let fetched = 0; fetched < MAX_PAGES && page !== null; fetched++) {
      let response;
      try {
        response = await this.guard.run(this.network, 'transactions', () =>
          this.cuelinks.transactions({ page: page ?? 1, updatedSince }),
        );
      } catch (err) {
        if (err instanceof ProviderUnavailableError) {
          // Stop cleanly. Nothing is lost: the next run starts from page 1
          // again, and the unique index makes the repeat harmless.
          this.logger.warn(`Conversion sync stopped (${err.reason}) after ${report.pages} page(s)`);
          break;
        }
        throw err;
      }

      const rows = response.transactions;
      report.pages++;
      report.transactions += rows.length;

      let newOnThisPage = 0;
      for (const row of rows) {
        const outcome = await this.upsert(row);
        if (outcome === 'inserted') {
          report.inserted++;
          newOnThisPage++;
        } else {
          report.updated++;
        }
        // Dimension one is the item id. Missing means a sale we cannot tie to
        // anything — worth counting, never worth dropping.
        if (!subIdsOf(row).itemId) report.unattributed++;
      }

      if (rows.length === 0) break;
      // On an unbounded first run, a full page with nothing new means we have
      // caught up with history and walking further only re-reads it. Once
      // `updated_since` narrows the window that test is wrong: every row in it
      // may legitimately be a *revision*, and stopping on the first such page
      // would drop the rest of the window.
      if (updatedSince === null && newOnThisPage === 0) break;

      // Must strictly advance. A vendor echoing the current page — or any
      // number below it — would otherwise spin until MAX_PAGES, re-reading the
      // same rows and burning the rate limit on every run.
      const next = response.nextPage;
      page = next !== null && next > (page ?? 1) ? next : null;
    }

    await this.touchState();

    if (report.transactions > 0) {
      this.logger.log(
        `Conversions: ${report.transactions} over ${report.pages} page(s) — ` +
          `${report.inserted} new, ${report.updated} revised, ${report.unattributed} unattributed`,
      );
      // Announced rather than acted on here: what a sale *means* for a gift is
      // the gifting module's business, and products must not learn about gifts
      // to tell it.
      this.emitter.emit(AFFILIATE_CONVERSIONS_SYNCED, {
        network: this.network,
        transactions: report.transactions,
      } satisfies AffiliateConversionsSyncedEvent);
    }
    return report;
  }

  /**
   * Upserts one transaction, keyed on the network's id.
   *
   * A network revises a sale — pending becomes confirmed, or cancelled, and the
   * commission moves — so the same id legitimately arrives more than once and
   * the later copy must win.
   */
  private async upsert(row: CuelinksTransaction): Promise<'inserted' | 'updated'> {
    if (row.id === undefined || row.id === null || row.id === '') return 'updated';

    const externalId = String(row.id);
    const subIds = subIdsOf(row);
    const status = row.status ?? null;

    const existing = await this.conversions
      .findOne({ network: this.network, externalId })
      .select({ status: 1 })
      .lean()
      .exec();

    const set: Record<string, unknown> = {
      campaignId: row.campaign_id ?? null,
      campaignName: row.campaign_name ?? null,
      itemId: ConversionSyncService.toObjectId(subIds.itemId),
      wishlistId: ConversionSyncService.toObjectId(subIds.wishlistId),
      userId: ConversionSyncService.toObjectId(subIds.userId),
      groupGiftId: ConversionSyncService.toObjectId(subIds.groupGiftId),
      clickTrackingId: subIds.clickId,
      orderId: row.order_id ?? null,
      merchantReferenceId: row.merchant_reference_id ?? null,
      productName: row.product_name ?? null,
      saleAmountMinor: ConversionSyncService.toMinor(row.sale_amount),
      commissionMinor: ConversionSyncService.toMinor(row.user_commission ?? row.commission),
      currency: row.currency ?? 'INR',
      status,
      transactionAt: ConversionSyncService.toDate(row.transaction_date ?? row.created_at),
      networkUpdatedAt: ConversionSyncService.toDate(row.updated_at),
    };

    // A revision is worth looking at again: pending becoming validated is the
    // moment an order stops being a claim and starts being a fact, and a row
    // already marked reconciled would otherwise never be reconsidered.
    if (!existing || existing.status !== status) set.reconciledAt = null;

    const result = await this.conversions
      .updateOne(
        { network: this.network, externalId },
        { $set: set, $setOnInsert: { network: this.network, externalId } },
        { upsert: true },
      )
      .exec();

    return result.upsertedCount > 0 ? 'inserted' : 'updated';
  }

  /**
   * How far back to ask, from when we last asked.
   *
   * A day of overlap rather than the exact timestamp: the two clocks are not
   * the same clock, and re-reading a handful of rows we already hold costs one
   * idempotent write each, while missing one loses a sale silently.
   */
  private async since(): Promise<Date | null> {
    const state = await this.state.findOne({ network: this.network }).lean().exec();
    if (!state?.lastSyncedAt) return null;
    return new Date(state.lastSyncedAt.getTime() - OVERLAP_MS);
  }

  /** Records that a run happened, so a stalled reconciliation is visible. */
  private async touchState(): Promise<void> {
    await this.state
      .updateOne(
        { network: this.network },
        { $set: { lastSyncedAt: new Date() }, $setOnInsert: { network: this.network } },
        { upsert: true },
      )
      .exec();
  }

  /** A sub-ID we did not set, or one the network mangled, must not throw. */
  private static toObjectId(value: string | null | undefined): Types.ObjectId | null {
    return value && Types.ObjectId.isValid(value) ? new Types.ObjectId(value) : null;
  }

  /**
   * Money, however the network spelled it.
   *
   * The documented shape is a decimal *string* ("1499.00") and some responses
   * answer a number; read as a number only, a string silently became null and
   * every sale looked like it was worth nothing.
   */
  private static toMinor(major: string | number | undefined | null): number | null {
    const value = typeof major === 'string' ? Number(major.trim()) : major;
    return typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 100) : null;
  }

  private static toDate(value: string | undefined): Date | null {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
}
