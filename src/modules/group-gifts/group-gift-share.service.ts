import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { ClientSession, Connection, Model, Types } from 'mongoose';
import {
  GROUP_GIFT_CONFIRM_REMINDER_DUE,
  GROUP_GIFT_DEADLINE_REMINDER_DUE,
  GROUP_GIFT_FUNDED,
  GROUP_GIFT_SHARE_REMINDER_DUE,
  type GroupGiftConfirmReminderDueEvent,
  type GroupGiftDeadlineReminderDueEvent,
  type GroupGiftFundedEvent,
  type GroupGiftShareReminderDueEvent,
} from 'src/common/events/domain-events';
import { LockService } from 'src/infra/redis/lock.service';
import { equalSplit, hostShareOf, type EqualSplit } from './equal-split';
import { withFunded, type GroupGiftUpdate } from './group-gift-funding';
import {
  CONTRIBUTABLE_GROUP_GIFT_STATUSES,
  ContributionMode,
  ContributionStatus,
  GroupGiftStatus,
  SettlementDirection,
  SettlementStatus,
} from './group-gift.types';
import { Settlement, type SettlementDocument } from './schemas/settlement.schema';
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
    @InjectModel(Settlement.name) private readonly settlementModel: Model<SettlementDocument>,
    @InjectConnection() private readonly connection: Connection,
    private readonly locks: LockService,
    private readonly emitter: EventEmitter2,
  ) {}

  /**
   * Everybody the total is divided among, but the host: the named members,
   * everybody who said yes to an invitation, and anybody who has paid in or
   * says they have. Never the recipient — the gift is for them — and never
   * somebody only asked: an invitation is a question, and a share is not
   * theirs until they answer it.
   */
  async othersIn(gift: GroupGiftDocument): Promise<string[]> {
    const host = gift.initiatorId.toString();
    const recipient = gift.recipientId.toString();
    const [invites, payers] = await Promise.all([
      this.inviteModel
        .find({ groupGiftId: gift._id, status: GroupGiftInviteStatus.ACCEPTED })
        .select('invitedUserId')
        .exec(),
      this.contributionModel
        .distinct('userId', {
          groupGiftId: gift._id,
          status: { $in: [ContributionStatus.CONFIRMED, ContributionStatus.PLEDGED] },
        })
        .exec(),
    ]);
    const ids = [
      ...gift.participantIds.map((id) => id.toString()),
      ...invites.map((i) => i.invitedUserId.toString()),
      ...payers.map((id) => id.toString()),
    ];
    return [...new Set(ids)].filter((id) => id !== host && id !== recipient);
  }

  /**
   * What each person has paid in, confirmed only, the host's share included —
   * less any refund the host has sent them. Somebody refunded after a price
   * drop has that much less in, and owes it again if the price comes back up.
   */
  async paidByUser(giftId: Types.ObjectId): Promise<Map<string, number>> {
    const [paid, back] = await Promise.all([
      this.sumByUser(giftId, ContributionStatus.CONFIRMED),
      this.settlementModel
        .aggregate<{ _id: Types.ObjectId; total: number }>([
          {
            $match: {
              groupGiftId: giftId,
              direction: SettlementDirection.RETURN,
              status: { $in: [SettlementStatus.SENT, SettlementStatus.CONFIRMED] },
            },
          },
          { $group: { _id: '$contributorId', total: { $sum: '$amountMinor' } } },
        ])
        .exec(),
    ]);
    for (const r of back) {
      const id = r._id.toString();
      paid.set(id, (paid.get(id) ?? 0) - r.total);
    }
    return paid;
  }

  /**
   * The most one more contribution may be: the goal, less what is in hand —
   * net of refunds the host has sent but not yet seen arrive — less what
   * members say they sent that the host has yet to confirm. Zero once the
   * goal is met, or once the gift stops taking money.
   *
   * Pending claims count against it, or two people could each be offered the
   * last ₹500 and both send it. And it is the limit, not a suggestion: the
   * money goes to the host outside the app, so trimming a larger amount down
   * on our side would record less than somebody actually sent.
   *
   * Read inside the contribution's transaction when given its [session], so
   * the check and the write see the same total.
   */
  async contributableMinor(gift: GroupGiftDocument, session?: ClientSession): Promise<number> {
    if (!CONTRIBUTABLE_GROUP_GIFT_STATUSES.includes(gift.status)) return 0;
    // One after the other: a transaction's session takes one operation at a time.
    const awaiting = await this.contributionModel
      .aggregate<{ total: number }>([
        { $match: { groupGiftId: gift._id, status: ContributionStatus.PLEDGED } },
        { $group: { _id: null, total: { $sum: '$amountMinor' } } },
      ])
      .session(session ?? null)
      .exec();
    const sent = await this.settlementModel
      .aggregate<{ total: number }>([
        {
          $match: {
            groupGiftId: gift._id,
            direction: SettlementDirection.RETURN,
            status: SettlementStatus.SENT,
          },
        },
        { $group: { _id: null, total: { $sum: '$amountMinor' } } },
      ])
      .session(session ?? null)
      .exec();
    const held = gift.collectedAmountMinor - (sent[0]?.total ?? 0);
    return Math.max(0, gift.targetAmountMinor - held - (awaiting[0]?.total ?? 0));
  }

  /** What each person says they sent that the host has not confirmed yet. */
  pendingByUser(giftId: Types.ObjectId): Promise<Map<string, number>> {
    return this.sumByUser(giftId, ContributionStatus.PLEDGED);
  }

  private async sumByUser(
    giftId: Types.ObjectId,
    status: ContributionStatus,
  ): Promise<Map<string, number>> {
    const rows = await this.contributionModel
      .aggregate<{ _id: Types.ObjectId; total: number }>([
        { $match: { groupGiftId: giftId, status } },
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
   * What [userId]'s share would be if they said yes: the split as it stands
   * with them counted in, paid nothing. What an invitation tells them.
   * Null for a custom-amount gift.
   */
  async shareIfJoined(gift: GroupGiftDocument, userId: string): Promise<number | null> {
    if (gift.contributionMode !== ContributionMode.EQUAL) return null;
    const [others, paid] = await Promise.all([this.othersIn(gift), this.paidByUser(gift._id)]);
    const members = others.includes(userId) ? others : [...others, userId];
    // The host's part as [sync] would record it with one more in the group —
    // the share on record now was worked out for a smaller group, so it is
    // backed out and the bigger group's put in its place.
    const hostId = gift.initiatorId.toString();
    const shareRow = await this.contributionModel
      .findOne({
        groupGiftId: gift._id,
        idempotencyKey: HOST_SHARE_KEY,
        status: ContributionStatus.CONFIRMED,
      })
      .select('amountMinor')
      .exec();
    const own = (paid.get(hostId) ?? 0) - (shareRow?.amountMinor ?? 0);
    const hostPaidMinor = Math.max(own, hostShareOf(gift.targetAmountMinor, members.length + 1));
    const split = equalSplit({
      targetMinor: gift.targetAmountMinor,
      hostId,
      hostPaidMinor,
      others: members.map((id) => ({ userId: id, paidMinor: paid.get(id) ?? 0 })),
    });
    return split.others.find((m) => m.userId === userId)?.shareMinor ?? null;
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
    const pending = await this.pendingByUser(gift._id);
    const row = (m: EqualSplit['host'], host: boolean) => ({
      userId: m.userId,
      name: nameOf(m.userId),
      host,
      shareMinor: m.shareMinor,
      paidMinor: m.paidMinor,
      owesMinor: m.owesMinor,
      pendingMinor: pending.get(m.userId) ?? 0,
    });
    let members = [row(split.host, true), ...split.others.map((m) => row(m, false))];
    // No longer collecting — funded, settled by the host, bought or called
    // off: nobody is asked for anything more, whatever the even split says.
    if (gift.status !== GroupGiftStatus.OPEN) {
      members = members.map((m) => ({ ...m, owesMinor: 0 }));
    }
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
    let funded: { collected: number; fundedCount: number } | null = null;
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
        let update: GroupGiftUpdate = { $inc: inc };
        if (collected >= fresh.targetAmountMinor && fresh.targetAmountMinor > 0) {
          update = withFunded(update, { at: now, by: 'system:funded' });
          funded = { collected, fundedCount: (fresh.fundedCount ?? 0) + 1 };
        }
        await this.groupGiftModel.updateOne({ _id: giftId }, update, { session }).exec();
      });
    } finally {
      await session.endSession();
    }

    const done = funded as { collected: number; fundedCount: number } | null;
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
        fundedCount: done.fundedCount,
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
      const claimed = await this.pendingByUser(gift._id);
      for (const member of split.others) {
        if (member.owesMinor <= 0) continue;
        // Says they have sent what they owe, and it is the host's turn: no
        // point asking them again until the host says it did not all arrive.
        if ((claimed.get(member.userId) ?? 0) >= member.owesMinor) continue;
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

  /**
   * "Three days left", "last day": to everybody in an open group who has not
   * paid — nothing confirmed, nothing marked sent — when the deadline is
   * within three days, and again within one. Whatever the split: on a custom
   * gift it says only that time is short. The host gets a count instead.
   *
   * Each day's reminder goes out once, recorded on the gift, so a job that
   * runs daily can run twice without asking twice. Returns how many were sent.
   */
  async remindDeadlines(now = new Date()): Promise<number> {
    const gifts = await this.groupGiftModel
      .find({ status: GroupGiftStatus.OPEN, deadline: { $gt: now } })
      .exec();
    let sent = 0;
    for (const gift of gifts) {
      const deadline = gift.deadline!;
      const daysLeft = Math.ceil((deadline.getTime() - now.getTime()) / 86_400_000);
      const already = gift.deadlineRemindersSent ?? [];
      // The nearest reminder that is due and not yet sent; a day-3 reminder
      // never sent is not sent on the last day on top of the last day's.
      const day = [1, 3].find((d) => daysLeft <= d && !already.includes(d));
      if (!day) continue;

      const [others, paidUp, split] = await Promise.all([
        this.othersIn(gift),
        this.settledUpUsers(gift._id),
        this.splitOf(gift),
      ]);
      const owes = new Map(split?.others.map((m) => [m.userId, m.owesMinor]) ?? []);
      const stillToPay = others.filter((id) => !paidUp.has(id) && (owes.get(id) ?? 1) > 0);

      await this.groupGiftModel
        .updateOne(
          { _id: gift._id },
          { $addToSet: { deadlineRemindersSent: { $each: [1, 3].filter((d) => d >= day) } } },
        )
        .exec();

      for (const userId of stillToPay) {
        this.emitter.emit(GROUP_GIFT_DEADLINE_REMINDER_DUE, {
          groupGiftId: gift._id.toString(),
          userId,
          day,
          owesMinor: split ? (owes.get(userId) ?? null) : null,
          title: gift.title,
          deadline,
          currency: gift.currency,
          isHost: false,
        } satisfies GroupGiftDeadlineReminderDueEvent);
        sent += 1;
      }
      if (stillToPay.length > 0) {
        this.emitter.emit(GROUP_GIFT_DEADLINE_REMINDER_DUE, {
          groupGiftId: gift._id.toString(),
          userId: gift.initiatorId.toString(),
          day,
          owesMinor: null,
          title: gift.title,
          deadline,
          currency: gift.currency,
          isHost: true,
          stillToPay: stillToPay.length,
        } satisfies GroupGiftDeadlineReminderDueEvent);
        sent += 1;
      }
    }
    return sent;
  }

  /**
   * Everybody who has paid, or says they have: a confirmed contribution, or
   * a pledge marked as sent. Nobody to chase about the deadline.
   */
  async settledUpUsers(giftId: Types.ObjectId): Promise<Set<string>> {
    const ids = await this.contributionModel
      .distinct('userId', {
        groupGiftId: giftId,
        $or: [
          { status: ContributionStatus.CONFIRMED },
          { status: ContributionStatus.PLEDGED, sentAt: { $ne: null } },
        ],
      })
      .exec();
    return new Set(ids.map((id) => id.toString()));
  }

  /**
   * One reminder a day to every host with payments still waiting for them to
   * confirm — until they have, since nothing counts until they do.
   */
  async remindHosts(now = new Date()): Promise<number> {
    const day = now.toISOString().slice(0, 10);
    const waiting = await this.contributionModel
      .aggregate<{ _id: Types.ObjectId; count: number; total: number }>([
        // Marked as sent: a pledge nobody has sent yet is nothing the host
        // can look for, and they are asked about it once it is.
        { $match: { status: ContributionStatus.PLEDGED, sentAt: { $ne: null } } },
        { $group: { _id: '$groupGiftId', count: { $sum: 1 }, total: { $sum: '$amountMinor' } } },
      ])
      .exec();
    if (waiting.length === 0) return 0;
    const gifts = await this.groupGiftModel
      .find({
        _id: { $in: waiting.map((w) => w._id) },
        status: { $in: [GroupGiftStatus.OPEN, GroupGiftStatus.CLOSED, GroupGiftStatus.FUNDED] },
      })
      .exec();
    const byId = new Map(waiting.map((w) => [w._id.toString(), w]));
    for (const gift of gifts) {
      const w = byId.get(gift._id.toString())!;
      this.emitter.emit(GROUP_GIFT_CONFIRM_REMINDER_DUE, {
        groupGiftId: gift._id.toString(),
        hostId: gift.initiatorId.toString(),
        title: gift.title,
        count: w.count,
        totalMinor: w.total,
        currency: gift.currency,
        day,
      } satisfies GroupGiftConfirmReminderDueEvent);
    }
    return gifts.length;
  }
}
