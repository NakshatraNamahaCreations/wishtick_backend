import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { ProviderGuard, ProviderUnavailableError } from '../providers/provider-guard.service';
import {
  AffiliateSyncState,
  Conversion,
  type AffiliateSyncStateDocument,
  type ConversionDocument,
} from '../schemas/conversion.schema';
import { CuelinksClient, type CuelinksTransaction } from './cuelinks.client';

export const CONVERSION_SYNC_JOB = 'affiliate-conversion-sync';

/** How many pages one run will pull. A bound, not a target. */
const MAX_PAGES = 20;

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

    for (let fetched = 0; fetched < MAX_PAGES && page !== null; fetched++) {
      let response;
      try {
        response = await this.guard.run(this.network, 'transactions', () =>
          this.cuelinks.transactions(page ?? 1),
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
        if (!row.subid) report.unattributed++;
      }

      // A full page with nothing new means we have caught up with history.
      // Walking further would re-read sales we already hold, every hour.
      if (rows.length === 0 || newOnThisPage === 0) break;

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
    if (!row.id) return 'updated';

    const result = await this.conversions
      .updateOne(
        { network: this.network, externalId: row.id },
        {
          $set: {
            campaignId: row.campaign_id ?? null,
            campaignName: row.campaign_name ?? null,
            itemId: ConversionSyncService.toObjectId(row.subid),
            wishlistId: ConversionSyncService.toObjectId(row.subid2),
            userId: ConversionSyncService.toObjectId(row.subid3),
            groupGiftId: ConversionSyncService.toObjectId(row.subid4),
            saleAmountMinor: ConversionSyncService.toMinor(row.sale_amount),
            commissionMinor: ConversionSyncService.toMinor(row.commission),
            currency: row.currency ?? 'INR',
            status: row.status ?? null,
            transactionAt: ConversionSyncService.toDate(row.transaction_date),
            networkUpdatedAt: ConversionSyncService.toDate(row.updated_at),
          },
          $setOnInsert: { network: this.network, externalId: row.id },
        },
        { upsert: true },
      )
      .exec();

    return result.upsertedCount > 0 ? 'inserted' : 'updated';
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

  private static toMinor(major: number | undefined): number | null {
    return typeof major === 'number' && Number.isFinite(major) ? Math.round(major * 100) : null;
  }

  private static toDate(value: string | undefined): Date | null {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
}
