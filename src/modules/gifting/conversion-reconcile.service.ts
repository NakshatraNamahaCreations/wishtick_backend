import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  AFFILIATE_CONVERSIONS_SYNCED,
  AFFILIATE_SALE_MATCHED,
  type AffiliateConversionsSyncedEvent,
  type AffiliateSaleMatchedEvent,
} from 'src/common/events/domain-events';
import {
  Conversion,
  type ConversionDocument,
} from 'src/modules/products/schemas/conversion.schema';
import { GiftMode, GiftStatus } from './gift.types';
import { GiftingService } from './gifting.service';
import { Gift, type GiftDocument } from './schemas/gift.schema';

/** One run's worth. A bound on the work, not a limit on the backlog. */
const BATCH = 200;

/**
 * Statuses that mean the network has checked the sale, not merely seen it.
 *
 * `pending` is a sale the merchant has reported and nobody has verified; the
 * rest are stages of it being validated and paid. Both are enough to say the
 * gift was bought — only the latter is enough to call the money real.
 */
const CONFIRMED_STATUSES = new Set(['validated', 'payable', 'invoice_raised', 'paid']);

/** A sale the network took back. Never evidence of a purchase. */
const REJECTED_STATUSES = new Set(['rejected', 'cancelled', 'declined']);

export interface ConversionReconcileReport {
  considered: number;
  /** Gifts moved from reserved to purchased by a reported sale. */
  purchased: number;
  /** Sales matched to a gift that had already been marked bought. */
  alreadyKnown: number;
  /** Sales with nothing of ours behind them — an ordinary click, usually. */
  unmatched: number;
}

/**
 * Turns a reported sale into a gift somebody no longer has to confirm.
 *
 * Until this existed, the only thing that could say a gift had been bought was
 * the gifter answering "yes, I bought it" on their way back from the merchant —
 * a dialog it is entirely normal to miss, after which the reservation quietly
 * expired and the item went back on the list. The affiliate network knows
 * independently, hours later, and this is where that knowledge is spent.
 *
 * It runs off the sync's event rather than on its own schedule: there is
 * nothing to reconcile until rows land, and a second clock would only be a
 * second thing to go quietly wrong.
 *
 * Conservative in one direction on purpose. A reported sale promotes a
 * reservation to purchased; a *rejected* sale never demotes anything, because
 * the gifter may well have bought the thing anyway — through a link we could
 * not track, or with the affiliate cookie stripped — and a gift that
 * un-purchases itself is worse than one that is a little optimistic.
 */
@Injectable()
export class ConversionReconcileService {
  private readonly logger = new Logger(ConversionReconcileService.name);

  constructor(
    @InjectModel(Conversion.name) private readonly conversions: Model<ConversionDocument>,
    @InjectModel(Gift.name) private readonly gifts: Model<GiftDocument>,
    private readonly gifting: GiftingService,
    private readonly emitter: EventEmitter2,
  ) {}

  @OnEvent(AFFILIATE_CONVERSIONS_SYNCED)
  async onSynced(e: AffiliateConversionsSyncedEvent): Promise<void> {
    try {
      await this.reconcile();
    } catch (err) {
      // The sync has already stored everything; a failure here loses nothing
      // but a tick, and the next run picks the same rows up again.
      this.logger.error(`Reconciling ${e.network} conversions failed: ${(err as Error).message}`);
    }
  }

  async reconcile(limit = BATCH): Promise<ConversionReconcileReport> {
    const report: ConversionReconcileReport = {
      considered: 0,
      purchased: 0,
      alreadyKnown: 0,
      unmatched: 0,
    };

    const pending = await this.conversions
      .find({ reconciledAt: null })
      .sort({ transactionAt: 1 })
      .limit(limit)
      .exec();

    for (const conversion of pending) {
      report.considered++;
      const rejected = REJECTED_STATUSES.has((conversion.status ?? '').toLowerCase());
      const orderRef = ConversionReconcileService.orderRef(conversion);
      let gift = await this.match(conversion);

      if (!gift && !rejected && conversion.itemId && conversion.userId) {
        // Bought without reserving first. The item is theirs from here on, so
        // nobody else is sent to buy it a second time.
        gift = await this.gifting.claimReportedSale(
          conversion.itemId.toString(),
          conversion.userId.toString(),
          { by: `system:${conversion.network}`, orderRef },
        );
        if (gift) {
          report.purchased++;
          await this.close(conversion, gift);
          this.emitMatched(conversion, gift);
          continue;
        }
      }

      if (!gift) {
        // Marked anyway: an ordinary wishlist click nobody reserved produces a
        // sale with no gift behind it, and retrying that every hour forever is
        // work with no possible outcome. A later revision clears the mark.
        report.unmatched++;
        await this.close(conversion, null);
        continue;
      }

      if (!rejected && gift.status === GiftStatus.RESERVED) {
        // Through the ordinary purchase path, so everything a purchase entails
        // still happens: the hold's expiry job is cancelled, the order is
        // minted, and the wishlist stops offering the item. Attributed to the
        // network, which is who actually saw the sale.
        await this.gifting.purchase(
          gift._id.toString(),
          gift.gifterId.toString(),
          { note: `Purchase reported by ${conversion.network}` },
          { by: `system:${conversion.network}`, orderRef },
        );
        report.purchased++;
      } else {
        report.alreadyKnown++;
        // The reference is what a later webhook, or a support question about a
        // missing commission, matches on — and nothing else has ever written
        // it, which is why the affiliate webhook could only ever dead-letter.
        if (!gift.orderRef) {
          await this.gifts.updateOne({ _id: gift._id }, { $set: { orderRef } }).exec();
        }
      }

      await this.close(conversion, gift);

      if (!rejected) this.emitMatched(conversion, gift);
    }

    if (report.considered > 0) {
      this.logger.log(
        `Reconciled ${report.considered} sale(s): ${report.purchased} gift(s) marked bought, ` +
          `${report.alreadyKnown} already known, ${report.unmatched} matched nothing`,
      );
    }
    return report;
  }

  /**
   * The gift a reported sale belongs to.
   *
   * Item **and** gifter, never item alone: two people can hold reservations on
   * the same item over time, and crediting the wrong one would mark a stranger's
   * gift bought. Only an active, online gift can match — an offline one was
   * bought somewhere we never sent them.
   */
  private async match(conversion: ConversionDocument): Promise<GiftDocument | null> {
    if (!conversion.itemId || !conversion.userId) return null;
    return this.gifts
      .findOne({
        itemId: conversion.itemId,
        gifterId: conversion.userId,
        mode: GiftMode.ONLINE,
        active: true,
      })
      .exec();
  }

  private emitMatched(conversion: ConversionDocument, gift: GiftDocument): void {
    this.emitter.emit(AFFILIATE_SALE_MATCHED, {
      giftId: gift._id.toString(),
      network: conversion.network,
      externalId: conversion.externalId,
      orderId: conversion.orderId,
      saleAmountMinor: conversion.saleAmountMinor,
      currency: conversion.currency,
      status: conversion.status,
      confirmed: CONFIRMED_STATUSES.has((conversion.status ?? '').toLowerCase()),
    } satisfies AffiliateSaleMatchedEvent);
  }

  private async close(conversion: ConversionDocument, gift: GiftDocument | null): Promise<void> {
    await this.conversions
      .updateOne(
        { _id: conversion._id },
        { $set: { reconciledAt: new Date(), giftId: gift?._id ?? null } },
      )
      .exec();
  }

  /** Namespaced, because two networks can mint the same number. */
  private static orderRef(conversion: ConversionDocument): string {
    return `${conversion.network}:${conversion.externalId}`;
  }
}
