import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model, Types } from 'mongoose';
import {
  GROUP_GIFT_FUNDED,
  GROUP_GIFT_SHARE_REMINDER_DUE,
  type GroupGiftFundedEvent,
  type GroupGiftShareReminderDueEvent,
} from 'src/common/events/domain-events';
import { LockService } from 'src/infra/redis/lock.service';
import { equalSplit, hostShareOf, type EqualSplit } from './equal-split';
import { ContributionMode, ContributionStatus, GroupGiftStatus } from './group-gift.types';
import type { EqualSplitView } from './group-gift.views';
import { Contribution, type ContributionDocument } from './schemas/contribution.schema';
import { GroupGift, type GroupGiftDocument } from './schemas/group-gift.schema';
import {
  GroupGiftInvite,
  GroupGiftInviteStatus,
  type GroupGiftInviteDocument,
} from './schemas/group-gift-invite.schema';

/**
 * The key the host's share is recorded under.
 *
 * One per group gift, by the unique `(groupGiftId, idempotencyKey)` index —
 * so two resyncs racing each other can never write it twice.
 */
export const HOST_SHARE_KEY = 'host-share';

/**
 * "Split equally", kept true as the group changes.
 *
 * The host's share is recorded as a real contribution, not worked out on the
 * side: they are the one collecting, so their part is in hand from the start,
 * and everything that already reads contributions — the progress bar, the
 * participants' "Paid", funding, settling up, the nightly reconcile — then
 * agrees with it without being taught anything new.
 *
 * That share moves with the headcount — ₹1,000 among five is ₹200, among four
 * ₹250 — so it is resynced whenever somebody is invited, joins, declines or
 * pays, and whenever the total changes. Only while the gift is open: once
 * funded, what was recorded stands.
 */
@Injectable()
export class GroupGiftShareService {
  private readonly logger = new Logger(GroupGiftShareService.name);

  constructor(
    @InjectModel(GroupGift.name) private readonly groupGiftModel: Model<GroupGiftDocument>,
    @InjectModel(Contribution.name)
    private readonly contributionModel: Model<ContributionDocument>,
    @InjectModel(GroupGiftInvite.name)
    private readonly inviteModel: Model<GroupGiftInviteDocument>,
    @InjectConnection() private readonly connection: Connection,
    private readonly locks: LockService,
    private readonly emitter: EventEmitter2,
  ) {}

  /**
   * Everybody the total is divided among, but the host: the named members,
   * everybody invited who has not said no, and anybody who has paid in. Never
   * the recipient — the gift is for them.
   */
  async othersIn(gift: GroupGiftDocument): Promise<string[]> {
    const host = gift.initiatorId.toString();
    const recipient = gift.recipientId.toString();
    const [invites, payers] = await Promise.all([
      this.inviteModel
        .find({ groupGiftId: gift._id, status: { $ne: GroupGiftInviteStatus.DECLINED } })
        .select('invitedUserId')
        .exec(),
      this.contributionModel
        .distinct('userId', { groupGiftId: gift._id, status: ContributionStatus.CONFIRMED })
        .exec(),
    ]);
    const ids = [
      ...gift.participantIds.map((id) => id.toString()),
      ...invites.map((i) => i.invitedUserId.toString()),
      ...payers.map((id) => id.toString()),
    ];
    return [...new Set(ids)].filter((id) => id !== host && id !== recipient);
  }

  /** What each person has paid in, confirmed only. The host's share included. */
  private async paidByUser(giftId: Types.ObjectId): Promise<Map<string, number>> {
    const rows = await this.contributionModel
      .aggregate<{ _id: Types.ObjectId; total: number }>([
        { $match: { groupGiftId: giftId, status: ContributionStatus.CONFIRMED } },
        { $group: { _id: '$userId', total: { $sum: '$amountMinor' } } },
      ])
      .exec();
    return new Map(rows.map((r) => [r._id.toString(), r.total]));
  }

  /** The split as it stands, or null for a gift not split equally. */
  async splitOf(gift: GroupGiftDocument): Promise<EqualSplit | null> {
    if (gift.contributionMode !== ContributionMode.EQUAL) return null;
    const [others, paid] = await Promise.all([this.othersIn(gift), this.paidByUser(gift._id)]);
    if (others.length === 0) return null;
    return equalSplit({
      targetMinor: gift.targetAmountMinor,
      hostId: gift.initiatorId.toString(),
      hostPaidMinor: paid.get(gift.initiatorId.toString()) ?? 0,
      others: others.map((userId) => ({ userId, paidMinor: paid.get(userId) ?? 0 })),
    });
  }

  /**
   * The split as the app shows it — everybody's share, what they have paid,
   * what they still owe, and the viewer's own. Null when there is no split:
   * a custom-amount gift, or a group of the host alone.
   */
  async viewFor(
    gift: GroupGiftDocument,
    viewerId: string,
    nameOf: (userId: string) => string,
  ): Promise<EqualSplitView | null> {
    const split = await this.splitOf(gift);
    if (!split) return null;
    const row = (m: EqualSplit['host'], host: boolean) => ({
      userId: m.userId,
      name: nameOf(m.userId),
      host,
      shareMinor: m.shareMinor,
      paidMinor: m.paidMinor,
      owesMinor: m.owesMinor,
    });
    const members = [row(split.host, true), ...split.others.map((m) => row(m, false))];
    const mine = members.find((m) => m.userId === viewerId) ?? null;
    return {
      memberCount: split.memberCount,
      baseShareMinor: split.baseShareMinor,
      members,
      myShareMinor: mine?.shareMinor ?? null,
      myOwesMinor: mine?.owesMinor ?? null,
    };
  }

  /**
   * Brings the host's recorded share in line with the group as it is now.
   *
   * Safe to call after anything: it changes nothing unless the headcount, the
   * total or the host's own payments have moved the share. Serialized per gift
   * with the same lock the contribute path takes, and the contribution and the
   * running total move together in one transaction — the collected figure is
   * money, and must never be half-updated.
   */
  /** True when it changed something — the caller's copy of the gift is stale. */
  async sync(groupGiftId: string | Types.ObjectId): Promise<boolean> {
    const id = groupGiftId.toString();
    try {
      return await this.locks.withBestEffortLock(
        `group-gift:${id}`,
        () => this.syncLocked(new Types.ObjectId(id)),
        { ttlMs: 5_000, retries: 15, retryDelayMs: 40 },
      );
    } catch (err) {
      // Never the reason a join or an invite fails: the next change, or the
      // nightly reconcile of the total, puts it right.
      this.logger.warn(`Host share for ${id} not resynced: ${(err as Error).message}`);
      return false;
    }
  }

  private async syncLocked(giftId: Types.ObjectId): Promise<boolean> {
    const gift = await this.groupGiftModel.findById(giftId).exec();
    if (!gift || gift.status !== GroupGiftStatus.OPEN) return false;

    const hostId = gift.initiatorId;
    const existing = await this.contributionModel
      .findOne({ groupGiftId: giftId, idempotencyKey: HOST_SHARE_KEY })
      .exec();
    const current = existing?.status === ContributionStatus.CONFIRMED ? existing.amountMinor : 0;

    let wanted = 0;
    let own = 0;
    if (gift.contributionMode === ContributionMode.EQUAL) {
      const others = await this.othersIn(gift);
      // What the host has put in themselves, besides the share recorded for them.
      const ownRows = await this.contributionModel
        .aggregate<{ total: number }>([
          {
            $match: {
              groupGiftId: giftId,
              userId: hostId,
              status: ContributionStatus.CONFIRMED,
              idempotencyKey: { $ne: HOST_SHARE_KEY },
            },
          },
          { $group: { _id: null, total: { $sum: '$amountMinor' } } },
        ])
        .exec();
      own = ownRows[0]?.total ?? 0;
      wanted = Math.max(0, hostShareOf(gift.targetAmountMinor, others.length + 1) - own);
      // Never more than is still needed: the share must not push the total
      // past the target on its own.
      wanted = Math.min(
        wanted,
        Math.max(0, gift.targetAmountMinor - (gift.collectedAmountMinor - current)),
      );
    }

    const delta = wanted - current;
    if (delta === 0) return false;

    const session = await this.connection.startSession();
    let funded: { collected: number } | null = null;
    try {
      await session.withTransaction(async () => {
        funded = null;
        const now = new Date();
        if (existing) {
          await this.contributionModel
            .updateOne(
              { _id: existing._id },
              {
                $set: {
                  amountMinor: wanted,
                  status: wanted > 0 ? ContributionStatus.CONFIRMED : ContributionStatus.REFUNDED,
                },
              },
              { session },
            )
            .exec();
        } else {
          await this.contributionModel.create(
            [
              {
                groupGiftId: giftId,
                userId: hostId,
                amountMinor: wanted,
                status: ContributionStatus.CONFIRMED,
                anonymous: false,
                message: null,
                idempotencyKey: HOST_SHARE_KEY,
              },
            ],
            { session },
          );
        }

        const fresh = await this.groupGiftModel.findById(giftId).session(session).exec();
        if (!fresh || fresh.status !== GroupGiftStatus.OPEN) return;
        const collected = fresh.collectedAmountMinor + delta;
        const inc: Record<string, number> = { collectedAmountMinor: delta };
        // The host counts as a contributor while their share is on record —
        // unless they already were, having paid in themselves.
        if (own === 0 && current === 0 && wanted > 0) inc.contributorCount = 1;
        if (own === 0 && current > 0 && wanted === 0) inc.contributorCount = -1;
        const update: Record<string, unknown> = { $inc: inc };
        if (collected >= fresh.targetAmountMinor && fresh.targetAmountMinor > 0) {
          update.$set = { status: GroupGiftStatus.FUNDED };
          update.$push = {
            history: { status: GroupGiftStatus.FUNDED, at: now, by: 'system:funded', note: null },
          };
          funded = { collected };
        }
        await this.groupGiftModel.updateOne({ _id: giftId }, update, { session }).exec();
      });
    } finally {
      await session.endSession();
    }

    const done = funded as { collected: number } | null;
    if (done) {
      this.emitter.emit(GROUP_GIFT_FUNDED, {
        groupGiftId: giftId.toString(),
        itemId: gift.itemId.toString(),
        wishlistId: gift.wishlistId.toString(),
        initiatorId: hostId.toString(),
        targetAmountMinor: gift.targetAmountMinor,
        collectedAmountMinor: done.collected,
        currency: gift.currency,
        contributorCount: 0,
      } satisfies GroupGiftFundedEvent);
    }
    return true;
  }

  /**
   * One reminder for everybody who still owes on an open, evenly split gift.
   *
   * Run once a day. Each reminder names the day in its reference, so every day
   * is a new notification rather than a repeat the dedupe swallows — the
   * reminders keep coming until the share is paid, and stop the day it is.
   */
  async remindOwing(now = new Date()): Promise<number> {
    const day = now.toISOString().slice(0, 10);
    const gifts = await this.groupGiftModel
      .find({ status: GroupGiftStatus.OPEN, contributionMode: ContributionMode.EQUAL })
      .exec();
    let sent = 0;
    for (const gift of gifts) {
      // Past its deadline nobody can pay any more, so there is nothing to ask.
      if (gift.deadline && gift.deadline.getTime() < now.getTime()) continue;
      // Put right first: a gift whose members arrived before the split was
      // kept would otherwise ask the others for the host's part too.
      await this.sync(gift._id);
      const split = await this.splitOf(gift);
      if (!split) continue;
      const pending = new Set(
        (
          await this.inviteModel
            .find({ groupGiftId: gift._id, status: GroupGiftInviteStatus.PENDING })
            .select('invitedUserId')
            .exec()
        ).map((i) => i.invitedUserId.toString()),
      );
      const members = new Set(gift.participantIds.map((id) => id.toString()));
      for (const member of split.others) {
        if (member.owesMinor <= 0) continue;
        this.emitter.emit(GROUP_GIFT_SHARE_REMINDER_DUE, {
          groupGiftId: gift._id.toString(),
          userId: member.userId,
          title: gift.title,
          owesMinor: member.owesMinor,
          shareMinor: member.shareMinor,
          paidMinor: member.paidMinor,
          currency: gift.currency,
          day,
          invited: pending.has(member.userId) && !members.has(member.userId),
        } satisfies GroupGiftShareReminderDueEvent);
        sent += 1;
      }
    }
    return sent;
  }
}
