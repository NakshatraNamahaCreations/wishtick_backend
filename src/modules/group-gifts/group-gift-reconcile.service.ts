import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  GROUP_GIFT_DRIFT_DETECTED,
  type GroupGiftDriftDetectedEvent,
} from 'src/common/events/domain-events';
import { ContributionStatus } from './group-gift.types';
import { Contribution, type ContributionDocument } from './schemas/contribution.schema';
import { GroupGift, type GroupGiftDocument } from './schemas/group-gift.schema';

export interface ReconcileResult {
  checked: number;
  drifted: number;
  corrected: number;
}

/**
 * The nightly guard on the denormalized `collectedAmountMinor`.
 *
 * The cache is only ever written by an atomic `$inc` inside the contribution
 * transaction, so it should never disagree with the sum of confirmed
 * contributions — but "should never" is exactly what a reconciler exists to
 * verify. It re-sums the source of truth, and on any mismatch it emits a loud
 * drift event AND corrects the cache to the true sum: converge to truth, but
 * make the fact that we had to correct it impossible to miss.
 *
 * Re-summing is naturally idempotent, so the repeatable job firing twice across
 * a deploy is harmless.
 */
@Injectable()
export class GroupGiftReconcileService {
  private readonly logger = new Logger(GroupGiftReconcileService.name);

  constructor(
    @InjectModel(GroupGift.name) private readonly groupGiftModel: Model<GroupGiftDocument>,
    @InjectModel(Contribution.name) private readonly contributionModel: Model<ContributionDocument>,
    private readonly emitter: EventEmitter2,
  ) {}

  async reconcile(): Promise<ReconcileResult> {
    // One pass: the confirmed sum per group gift. Gifts with no confirmed
    // contributions simply do not appear and default to a summed value of 0.
    const sums = await this.contributionModel
      .aggregate<{ _id: unknown; summed: number }>([
        { $match: { status: ContributionStatus.CONFIRMED } },
        { $group: { _id: '$groupGiftId', summed: { $sum: '$amountMinor' } } },
      ])
      .exec();
    const summedById = new Map<string, number>(sums.map((s) => [String(s._id), s.summed]));

    let checked = 0;
    let drifted = 0;
    let corrected = 0;

    // Stream every group gift so a large collection never loads into memory.
    const cursor = this.groupGiftModel.find().cursor();
    for await (const gift of cursor) {
      checked += 1;
      const summed = summedById.get(gift._id.toString()) ?? 0;
      const cached = gift.collectedAmountMinor;
      if (summed === cached) continue;

      drifted += 1;
      const drift = cached - summed;
      this.logger.error(
        `Drift on group gift ${gift._id.toString()}: cached ${cached} vs summed ${summed} (Δ ${drift}); correcting to the sum`,
      );
      this.emitter.emit(GROUP_GIFT_DRIFT_DETECTED, {
        groupGiftId: gift._id.toString(),
        cachedAmountMinor: cached,
        summedAmountMinor: summed,
        driftMinor: drift,
      } satisfies GroupGiftDriftDetectedEvent);

      // The sum is the source of truth: converge the cache to it.
      const res = await this.groupGiftModel
        .updateOne({ _id: gift._id }, { $set: { collectedAmountMinor: summed } })
        .exec();
      if (res.modifiedCount === 1) corrected += 1;
    }

    if (drifted === 0) {
      this.logger.log(`Reconciled ${checked} group gift(s); no drift`);
    } else {
      this.logger.warn(
        `Reconciled ${checked} group gift(s); corrected ${corrected}/${drifted} drifted`,
      );
    }
    return { checked, drifted, corrected };
  }
}
