import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { AppException } from 'src/common/errors/app.exception';
import { ErrorCode } from 'src/common/errors/error-codes';
import {
  GROUP_GIFT_FUNDED,
  SETTLEMENT_CONFIRMED,
  SETTLEMENT_RAISED,
  SETTLEMENT_RETURN_RAISED,
  SETTLEMENT_SENT,
  SETTLEMENT_TOP_UP_REQUESTED,
  SETTLEMENT_UPI_SHARED,
  type GroupGiftFundedEvent,
  type SettlementConfirmedEvent,
  type SettlementRaisedEvent,
  type SettlementReturnRaisedEvent,
  type SettlementRowEvent,
  type SettlementSentEvent,
  type SettlementTopUpRequestedEvent,
  type SettlementUpiSharedEvent,
} from 'src/common/events/domain-events';
import type { AppConfig } from 'src/config/configuration';
import {
  UserProfile,
  type UserProfileDocument,
} from 'src/modules/profile/schemas/user-profile.schema';
import { hostShareOf } from './equal-split';
import { withFunded } from './group-gift-funding';
import { GroupGiftShareService, HOST_SHARE_KEY } from './group-gift-share.service';
import {
  ContributionMode,
  ContributionStatus,
  DECIDABLE_GROUP_GIFT_STATUSES,
  GroupGiftStatus,
  INACTIVE_GROUP_GIFT_STATUSES,
  SettlementDirection,
  SettlementStatus,
} from './group-gift.types';
import { Contribution, type ContributionDocument } from './schemas/contribution.schema';
import { GroupGift, type GroupGiftDocument } from './schemas/group-gift.schema';
import { Settlement, type SettlementDocument } from './schemas/settlement.schema';

/** What the group owes, or is owed, once every cost is counted. */
export interface GroupGiftBalance {
  /** Primary item + extra lines + charges. */
  totalCostMinor: number;
  /** Everything promised, settled or not. */
  pledgedMinor: number;
  /** What the host holds now: acknowledged contributions, less any returned. */
  collectedMinor: number;
  /** Surplus already handed back, and confirmed by the person who got it. */
  returnedMinor: number;
  /**
   * `collected − totalCost`. Positive is a surplus the host owes back; negative
   * is a shortfall the group owes. Zero means square.
   */
  differenceMinor: number;
  direction: SettlementDirection | null;
  contributorCount: number;
}

/** Who gets a surplus back, and the host's own part of it, which they keep. */
interface RefundPlan {
  members: { contributorId: string; amountMinor: number }[];
  hostKeptMinor: number;
}

/** What re-balancing after a price change did to the money. */
export interface RebalanceOutcome {
  /** Refunds now owed by the host to members, raised by this re-balance. */
  refundMinor: number;
  /** Refunds called off because the price moved again before they were sent. */
  cancelledRefundMinor: number;
  /** The host's own slice of a surplus — kept, not refunded to themselves. */
  hostKeptMinor: number;
  /** What the group still needs beyond everything the host holds. */
  shortfallMinor: number;
}

@Injectable()
export class SettlementService {
  constructor(
    @InjectModel(GroupGift.name) private readonly groupGifts: Model<GroupGiftDocument>,
    @InjectModel(Contribution.name) private readonly contributions: Model<ContributionDocument>,
    @InjectModel(Settlement.name) private readonly settlements: Model<SettlementDocument>,
    @InjectModel(UserProfile.name) private readonly profiles: Model<UserProfileDocument>,
    private readonly shares: GroupGiftShareService,
    // Each step of settling up tells the person on the other side of it.
    private readonly emitter: EventEmitter2,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  /**
   * Puts the money right after the host moves the goal to a new shop price.
   *
   * The rules, in the owner's words: if the price drops, the host must refund
   * the excess; if it comes back up before the refund is made, nobody needs
   * one; if it goes up after the refund, the group is asked for more.
   *
   * So, every time: refunds nobody has sent yet are called off — the balance
   * they were raised for is gone — and the new goal is set against what the
   * host actually holds (collected, less refunds already sent). More than the
   * goal: refunds are raised again for the difference, owed by the host. Less:
   * the shortfall is reported, and the caller asks the group for it. A price
   * that went down and came back before anything was sent therefore ends with
   * no refund and nothing asked of anyone.
   */
  async rebalanceAfterPriceChange(groupGiftId: string): Promise<RebalanceOutcome> {
    const gg = await this.load(groupGiftId);

    const pending = await this.settlements
      .find({
        groupGiftId: gg._id,
        direction: SettlementDirection.RETURN,
        status: SettlementStatus.PENDING,
      })
      .exec();
    const cancelledRefundMinor = pending.reduce((sum, s) => sum + s.amountMinor, 0);
    if (pending.length > 0) {
      await this.settlements
        .updateMany(
          { _id: { $in: pending.map((s) => s._id) } },
          {
            $set: {
              status: SettlementStatus.CANCELLED,
              note: 'Not needed: the price changed again before it was sent',
            },
          },
        )
        .exec();
    }

    const sentMinor = await this.sentReturnsMinor(gg._id);
    const held = gg.collectedAmountMinor - sentMinor;
    const surplus = held - gg.targetAmountMinor;
    if (surplus <= 0) {
      return {
        refundMinor: 0,
        cancelledRefundMinor,
        hostKeptMinor: 0,
        shortfallMinor: Math.max(0, -surplus),
      };
    }

    const { members, hostKeptMinor } = await this.refundPlan(gg, surplus);

    if (hostKeptMinor > 0) await this.keepForHost(gg, hostKeptMinor);
    const { rows: raised } = await this.raise(
      gg,
      SettlementDirection.RETURN,
      members,
      'The price dropped, so this is coming back to you',
    );
    return {
      refundMinor: raised
        .filter((s) => s.status === SettlementStatus.PENDING)
        .reduce((sum, s) => sum + s.amountMinor, 0),
      cancelledRefundMinor,
      hostKeptMinor,
      shortfallMinor: 0,
    };
  }

  /**
   * Who gets [surplus] back — the one rule for refunds, whether a price change
   * raised them or the host pressed "Refund the extra".
   *
   * Split equally: each person gets back what they paid above the share, the
   * host's included. Any amounts: in proportion to what each put in, so nobody
   * gets back more than they gave. Either way the host's own part is theirs
   * to keep — never a refund raised from them to themselves.
   */
  private async refundPlan(gg: GroupGiftDocument, surplus: number): Promise<RefundPlan> {
    const paid = await this.netPaidByUser(gg._id);
    const hostId = gg.initiatorId.toString();
    if (gg.contributionMode !== ContributionMode.EQUAL) {
      return SettlementService.proportionalRefunds(hostId, paid, surplus);
    }
    const others = await this.shares.othersIn(gg);
    return SettlementService.equalRefunds({
      hostId,
      others,
      paid,
      targetMinor: gg.targetAmountMinor,
      surplus,
    });
  }

  /**
   * An even split's refunds: what each person paid above the share. When that
   * comes to more than the surplus — somebody else still owes theirs — what
   * there is goes round in proportion to how far over each one is, rather
   * than to whoever happens to be first.
   */
  static equalRefunds(input: {
    hostId: string;
    others: string[];
    paid: Map<string, number>;
    targetMinor: number;
    surplus: number;
  }): RefundPlan {
    const { hostId, others, paid, targetMinor, surplus } = input;
    const count = others.length + 1;
    const base = Math.floor(targetMinor / count);
    const hostOver: [string, number] = [
      hostId,
      (paid.get(hostId) ?? 0) - hostShareOf(targetMinor, count),
    ];
    const over = [
      ...others.map((id): [string, number] => [id, (paid.get(id) ?? 0) - base]),
      hostOver,
    ].filter(([, amount]) => amount > 0);
    return SettlementService.planFrom(hostId, over, surplus);
  }

  /**
   * Any-amount refunds: the surplus shared in proportion to what each person
   * put in, so nobody gets back more than they gave. The host's own part is
   * theirs to keep. Paise that do not divide go to the biggest givers.
   */
  static proportionalRefunds(
    hostId: string,
    paid: Map<string, number>,
    surplus: number,
  ): RefundPlan {
    return SettlementService.planFrom(
      hostId,
      [...paid.entries()].filter(([, amount]) => amount > 0),
      surplus,
    );
  }

  /**
   * Shares up to [surplus] across [weights] in proportion — never more than a
   * weight to anyone — and splits off the host's part. Paise that do not
   * divide go to the biggest weights, so the total is exact.
   */
  private static planFrom(
    hostId: string,
    weights: [string, number][],
    surplus: number,
  ): RefundPlan {
    const sorted = [...weights].sort((a, b) => b[1] - a[1]);
    const total = sorted.reduce((sum, [, w]) => sum + w, 0);
    if (total <= 0 || surplus <= 0) return { members: [], hostKeptMinor: 0 };
    const amount = Math.min(surplus, total);
    const shares = sorted.map(([userId, w]) => ({
      userId,
      share: Math.floor((amount * w) / total),
    }));
    let remainder = amount - shares.reduce((sum, s) => sum + s.share, 0);
    for (const s of shares) {
      if (remainder <= 0) break;
      s.share += 1;
      remainder -= 1;
    }
    return {
      members: shares
        .filter((s) => s.userId !== hostId && s.share > 0)
        .map((s) => ({ contributorId: s.userId, amountMinor: s.share })),
      hostKeptMinor: shares.find((s) => s.userId === hostId)?.share ?? 0,
    };
  }

  /**
   * The host's own slice of a surplus: no refund to raise — they already have
   * it — but it no longer counts towards the gift. On an even split it comes
   * off the share recorded for them, which is resynced if the goal rises
   * again; anything beyond that is written as a return they made to
   * themselves, settled at once.
   */
  private async keepForHost(gg: GroupGiftDocument, amountMinor: number): Promise<void> {
    let left = amountMinor;
    const hostShare = await this.contributions
      .findOne({
        groupGiftId: gg._id,
        idempotencyKey: HOST_SHARE_KEY,
        status: ContributionStatus.CONFIRMED,
      })
      .exec();
    if (hostShare && left > 0) {
      const trim = Math.min(left, hostShare.amountMinor);
      const remaining = hostShare.amountMinor - trim;
      await this.contributions
        .updateOne(
          { _id: hostShare._id },
          {
            $set: {
              amountMinor: remaining,
              status: remaining > 0 ? ContributionStatus.CONFIRMED : ContributionStatus.REFUNDED,
            },
          },
        )
        .exec();
      left -= trim;
    }
    if (left > 0) {
      const now = new Date();
      await this.settlements.create({
        groupGiftId: gg._id,
        contributorId: gg.initiatorId,
        hostId: gg.initiatorId,
        direction: SettlementDirection.RETURN,
        amountMinor: left,
        currency: gg.currency,
        status: SettlementStatus.CONFIRMED,
        sentAt: now,
        confirmedAt: now,
        note: 'Kept by the host: their own part of the extra',
      });
    }
    await this.groupGifts
      .updateOne({ _id: gg._id }, { $inc: { collectedAmountMinor: -amountMinor } })
      .exec();
  }

  /** Refunds the host says have gone out but nobody has confirmed yet. */
  async sentReturnsMinor(groupGiftId: Types.ObjectId): Promise<number> {
    const rows = await this.settlements
      .find({ groupGiftId, direction: SettlementDirection.RETURN, status: SettlementStatus.SENT })
      .exec();
    return rows.reduce((sum, s) => sum + s.amountMinor, 0);
  }

  /** Refunds raised and not sent yet. */
  async pendingReturnsMinor(groupGiftId: Types.ObjectId): Promise<number> {
    const rows = await this.settlements
      .find({
        groupGiftId,
        direction: SettlementDirection.RETURN,
        status: SettlementStatus.PENDING,
      })
      .exec();
    return rows.reduce((sum, s) => sum + s.amountMinor, 0);
  }

  /**
   * What each person has put in and still has in: confirmed money, less any
   * refund sent or confirmed back to them.
   */
  private async netPaidByUser(groupGiftId: Types.ObjectId): Promise<Map<string, number>> {
    const [given, back] = await Promise.all([
      this.contributions
        .aggregate<{ _id: Types.ObjectId; total: number }>([
          { $match: { groupGiftId, status: ContributionStatus.CONFIRMED } },
          { $group: { _id: '$userId', total: { $sum: '$amountMinor' } } },
        ])
        .exec(),
      this.settlements
        .aggregate<{ _id: Types.ObjectId; total: number }>([
          {
            $match: {
              groupGiftId,
              direction: SettlementDirection.RETURN,
              status: { $in: [SettlementStatus.SENT, SettlementStatus.CONFIRMED] },
            },
          },
          { $group: { _id: '$contributorId', total: { $sum: '$amountMinor' } } },
        ])
        .exec(),
    ]);
    const net = new Map(given.map((r) => [r._id.toString(), r.total]));
    for (const r of back) {
      const id = r._id.toString();
      net.set(id, (net.get(id) ?? 0) - r.total);
    }
    return net;
  }

  /**
   * The full cost of a group gift.
   *
   * Simply the target: the bill — gifts plus charges — is agreed before the
   * first contribution (`4007:568` → *"Proceed to Contribution"*), and
   * `GroupGiftService.recomputeTarget` keeps `targetAmountMinor` equal to that
   * Grand Total. Re-adding lines and charges here would count them twice.
   *
   * A shortfall therefore never comes from a charge appearing late. It comes
   * from the *item price moving* — which is exactly what the contribution
   * request says: *"The gift price has increased a bit."* (`4092:174`).
   */
  static totalCostMinor(gg: GroupGiftDocument): number {
    return gg.targetAmountMinor;
  }

  async balance(groupGiftId: string, viewerId?: string): Promise<GroupGiftBalance> {
    const gg = await this.load(groupGiftId);
    if (viewerId !== undefined) await this.assertInTheGroup(gg, viewerId);
    const totalCostMinor = SettlementService.totalCostMinor(gg);

    const rows = await this.contributions
      .find({
        groupGiftId: gg._id,
        status: { $in: [ContributionStatus.PLEDGED, ContributionStatus.CONFIRMED] },
      })
      .exec();

    const pledgedMinor = rows.reduce((sum, r) => sum + r.amountMinor, 0);
    const contributedMinor = rows
      .filter((r) => r.status === ContributionStatus.CONFIRMED)
      .reduce((sum, r) => sum + r.amountMinor, 0);

    // Money already handed back is money the host no longer has. Without this
    // a returned surplus still read as a surplus, and the host could raise the
    // same refund again and again.
    const returned = await this.settlements
      .find({
        groupGiftId: gg._id,
        direction: SettlementDirection.RETURN,
        status: SettlementStatus.CONFIRMED,
      })
      .exec();
    const returnedMinor = returned.reduce((sum, r) => sum + r.amountMinor, 0);
    const collectedMinor = contributedMinor - returnedMinor;

    // Measured against what the host actually holds, not what was promised: a
    // host cannot hand back money nobody has given them.
    const differenceMinor = collectedMinor - totalCostMinor;

    return {
      totalCostMinor,
      pledgedMinor,
      collectedMinor,
      returnedMinor,
      differenceMinor,
      direction:
        differenceMinor > 0
          ? SettlementDirection.RETURN
          : differenceMinor < 0
            ? SettlementDirection.TOP_UP
            : null,
      contributorCount: new Set(rows.map((r) => r.userId.toString())).size,
    };
  }

  /**
   * Raises one settlement per contributor, splitting [amountMinor] between
   * them (`4093:444` "Split equally" / "Custom").
   *
   * The remainder problem is real and silent if ignored: ₹2,000 across 6 people
   * is ₹333.33 each, and six ₹333 payments return ₹1,998 — leaving ₹2 the host
   * still owes and nobody is tracking. The extra paise go to the earliest
   * contributors, so the split always sums to exactly the amount.
   */
  static splitEvenly(amountMinor: number, count: number): number[] {
    if (count <= 0) return [];
    const base = Math.floor(amountMinor / count);
    let remainder = amountMinor - base * count;
    return Array.from({ length: count }, () => {
      const extra = remainder > 0 ? 1 : 0;
      remainder -= extra;
      return base + extra;
    });
  }

  /**
   * The host returns a surplus — "Refund the extra".
   *
   * Only the host may raise these: the amounts decide what the host is publicly
   * on the hook for, and a contributor being able to mint their own refund
   * would be an obvious abuse.
   *
   * By the same rule a price drop's refunds follow ([refundPlan]): the host
   * keeps their own part rather than being sent a refund from themselves,
   * which the even split among every contributor used to do. Refunds already
   * set up and not yet answered are what is owed; pressing again hands those
   * back rather than raising a second set.
   */
  async distributeReturn(
    groupGiftId: string,
    hostId: string,
    input: { custom?: { contributorId: string; amountMinor: number }[]; note?: string },
  ): Promise<SettlementDocument[]> {
    const gg = await this.load(groupGiftId);
    this.assertHost(gg, hostId);
    SettlementService.assertActive(gg);

    const balance = await this.balance(groupGiftId);
    // What is extra and not already on its way back.
    const outstanding =
      (await this.sentReturnsMinor(gg._id)) + (await this.pendingReturnsMinor(gg._id));
    const surplus = balance.differenceMinor - outstanding;
    if (surplus <= 0) {
      if (outstanding > 0) return this.openReturns(gg._id);
      throw new AppException(
        ErrorCode.CONTRIBUTION_AMOUNT_INVALID,
        'There is no surplus to return',
        409,
      );
    }

    let plan: RefundPlan;
    if (input.custom) {
      const total = input.custom.reduce((sum, c) => sum + c.amountMinor, 0);
      if (total > surplus) {
        throw new AppException(
          ErrorCode.CONTRIBUTION_AMOUNT_INVALID,
          'The split is larger than the surplus',
          409,
        );
      }
      // The host naming themselves in a custom split is keeping that much.
      plan = {
        members: await this.validCustomReturns(
          gg,
          input.custom.filter((c) => c.contributorId !== hostId),
        ),
        hostKeptMinor: input.custom
          .filter((c) => c.contributorId === hostId)
          .reduce((sum, c) => sum + c.amountMinor, 0),
      };
    } else {
      plan = await this.refundPlan(gg, surplus);
    }
    if (plan.members.length === 0 && plan.hostKeptMinor === 0) {
      throw new AppException(
        ErrorCode.CONTRIBUTION_AMOUNT_INVALID,
        'Nobody has contributed yet',
        409,
      );
    }

    if (plan.hostKeptMinor > 0) await this.keepForHost(gg, plan.hostKeptMinor);
    const { rows, fresh } = await this.raise(
      gg,
      SettlementDirection.RETURN,
      plan.members,
      input.note ?? null,
    );
    // One note in the group's chat for the lot, rather than one per person.
    if (fresh.length > 0) {
      this.emitter.emit(SETTLEMENT_RETURN_RAISED, {
        groupGiftId: gg._id.toString(),
        hostId,
        title: gg.title,
        totalMinor: fresh.reduce((sum, s) => sum + s.amountMinor, 0),
        count: fresh.length,
        currency: gg.currency,
        raisedAt: new Date(),
      } satisfies SettlementReturnRaisedEvent);
    }
    return rows;
  }

  /**
   * A custom refund split, held to who actually paid: every row a real
   * contributor, and nobody given back more than they still have in —
   * what they paid, less refunds already raised, sent or confirmed to them.
   * Without this a host could raise a "refund" to anybody, for anything,
   * and the group's balance would show money going to someone who never
   * put any in.
   */
  private async validCustomReturns(
    gg: GroupGiftDocument,
    rows: { contributorId: string; amountMinor: number }[],
  ): Promise<{ contributorId: string; amountMinor: number }[]> {
    // Sent and confirmed refunds are already out of this; pending ones are not.
    const [held, pending] = await Promise.all([
      this.shares.paidByUser(gg._id),
      this.settlements
        .aggregate<{ _id: Types.ObjectId; total: number }>([
          {
            $match: {
              groupGiftId: gg._id,
              direction: SettlementDirection.RETURN,
              status: SettlementStatus.PENDING,
            },
          },
          { $group: { _id: '$contributorId', total: { $sum: '$amountMinor' } } },
        ])
        .exec(),
    ]);
    const raised = new Map(pending.map((r) => [r._id.toString(), r.total]));
    const asked = new Map<string, number>();
    for (const row of rows) {
      asked.set(row.contributorId, (asked.get(row.contributorId) ?? 0) + row.amountMinor);
    }
    for (const [contributorId, amountMinor] of asked) {
      const paid = held.get(contributorId) ?? 0;
      if (paid <= 0) {
        throw new AppException(
          ErrorCode.VALIDATION_FAILED,
          'A refund can only go to somebody who has paid in',
          400,
          { contributorId },
        );
      }
      const maxMinor = Math.max(0, paid - (raised.get(contributorId) ?? 0));
      if (amountMinor > maxMinor) {
        throw new AppException(
          ErrorCode.CONTRIBUTION_AMOUNT_INVALID,
          'Nobody can be given back more than they put in',
          400,
          { contributorId, maxMinor },
        );
      }
    }
    return [...asked].map(([contributorId, amountMinor]) => ({ contributorId, amountMinor }));
  }

  /** Every refund raised and not yet answered, oldest first. */
  private openReturns(groupGiftId: Types.ObjectId): Promise<SettlementDocument[]> {
    return this.settlements
      .find({
        groupGiftId,
        direction: SettlementDirection.RETURN,
        status: { $in: [SettlementStatus.PENDING, SettlementStatus.SENT] },
      })
      .sort({ createdAt: 1 })
      .exec();
  }

  /**
   * The host asks the group for more money (`4092:174`).
   *
   * The amount is supplied, not derived. The bill is agreed before anyone
   * contributes, so a shortfall never appears on its own — it appears because
   * something outside Wishtick moved, which is exactly what the frame says:
   * *"The gift price has increased a bit."* Only the host can see that, so only
   * the host can quantify it.
   *
   * Raising the target and raising the settlements is one operation: a request
   * for ₹2,000 that did not also move the goal would leave the progress bar
   * claiming the group was already fully funded.
   *
   * Split across *named members* rather than only past contributors — the
   * frame's copy is "Each Member needs to add ₹333", and someone who joined
   * without pledging is still a member. The host is one of them and pays an
   * equal share, counted as paid at once rather than raised as a request —
   * see below. A host who is the group's only member simply covers it all.
   */
  async requestTopUp(
    groupGiftId: string,
    hostId: string,
    input: { additionalAmountMinor: number; note?: string },
  ): Promise<SettlementDocument[]> {
    const gg = await this.load(groupGiftId);
    this.assertHost(gg, hostId);
    SettlementService.assertActive(gg);
    // Until it is bought. After that the gift is in the host's hands and the
    // price is what was paid: a shortfall then is theirs, not a new ask.
    if (
      ![GroupGiftStatus.OPEN, GroupGiftStatus.FUNDED, GroupGiftStatus.CLOSED].includes(gg.status)
    ) {
      throw new AppException(
        ErrorCode.GROUP_GIFT_NOT_OPEN,
        'You can ask for more only until the gift is bought',
        409,
        { status: gg.status },
      );
    }

    if (input.additionalAmountMinor <= 0) {
      throw new AppException(
        ErrorCode.CONTRIBUTION_AMOUNT_INVALID,
        'A contribution request needs a positive amount',
        400,
      );
    }
    // The same ceiling a goal is held to when it is set.
    const maxTarget = this.config.get('groupGifting.maxTargetMinor', { infer: true });
    if (gg.targetAmountMinor + input.additionalAmountMinor > maxTarget) {
      throw new AppException(
        ErrorCode.CONTRIBUTION_AMOUNT_INVALID,
        `Target exceeds the maximum of ${maxTarget} minor units`,
        400,
        { maxTargetMinor: maxTarget },
      );
    }

    // The host first, then everybody else. The host pays a share like any
    // member — they started the group, and a rise in price is theirs to share
    // in too — and first in line means any odd paise of an uneven split land
    // on them rather than on the people being asked.
    const others = gg.participantIds.map((id) => id.toString()).filter((id) => id !== hostId);
    const payers = [hostId, ...others];

    gg.targetAmountMinor += input.additionalAmountMinor;
    // Reopened, so the gap can be closed the ordinary way as well as through
    // the settlements raised below: only an open group accepts money, and a
    // funded one left funded would have a target nobody could reach.
    if (gg.status === GroupGiftStatus.FUNDED) {
      gg.status = GroupGiftStatus.OPEN;
      gg.history.push({
        status: GroupGiftStatus.OPEN,
        at: new Date(),
        by: hostId,
        note: 'reopened by a contribution request',
      });
    }
    await gg.save();

    const [hostShare, ...othersShares] = SettlementService.splitEvenly(
      input.additionalAmountMinor,
      payers.length,
    );

    // The host's share is not a request. A top-up is paid *to* the host, so a
    // settlement for it would be the host owing themselves — there is nothing
    // to chase and nobody to confirm it. It counts as their contribution the
    // moment they ask, which is also what they are committing to by asking.
    if (hostShare > 0) {
      await this.credit({
        groupGiftId: gg._id,
        userId: gg.initiatorId,
        amountMinor: hostShare,
        key: `top-up-host:${new Types.ObjectId().toString()}`,
      });
    }

    const allocations = othersShares.map((amountMinor, i) => ({
      contributorId: others[i],
      amountMinor,
    }));
    const { rows } = await this.raise(
      gg,
      SettlementDirection.TOP_UP,
      allocations,
      input.note ?? null,
    );
    const recipient = gg.recipientId.toString();
    this.emitter.emit(SETTLEMENT_TOP_UP_REQUESTED, {
      groupGiftId: gg._id.toString(),
      hostId,
      title: gg.title,
      additionalAmountMinor: input.additionalAmountMinor,
      targetAmountMinor: gg.targetAmountMinor,
      memberIds: others.filter((id) => id !== recipient),
      currency: gg.currency,
      note: input.note ?? null,
    } satisfies SettlementTopUpRequestedEvent);
    return rows;
  }

  /**
   * Records a UPI ID against an open settlement, and optionally saves it for
   * next time (`4095:611`).
   *
   * Only the person being paid may set it — a host filling in someone else's
   * UPI ID would be directing money to an account of their choosing.
   */
  async shareUpi(
    settlementId: string,
    userId: string,
    upiId: string,
    saveToProfile: boolean,
  ): Promise<SettlementDocument> {
    const { settlement, gg } = await this.loadSettlement(settlementId);
    const receiverId = SettlementService.receiverOf(settlement);

    if (receiverId !== userId) {
      throw new AppException(
        ErrorCode.FORBIDDEN,
        'Only the person being paid can share a UPI ID',
        403,
      );
    }

    const changed = settlement.upiId !== upiId;
    settlement.upiId = upiId;
    await settlement.save();
    // The payer now knows where to send it. Not again for the same ID.
    if (changed) {
      this.emitter.emit(SETTLEMENT_UPI_SHARED, {
        ...SettlementService.rowEvent(settlement, gg),
        upiId,
      } satisfies SettlementUpiSharedEvent);
    }

    if (saveToProfile) {
      // Upsert, not update: a profile row is created during onboarding, and a
      // user who skipped it — or who signed up before profiles existed — has
      // none. A plain updateOne would match nothing and report success, so the
      // "save this for next time" checkbox would silently do nothing forever.
      await this.profiles
        .updateOne(
          { userId: new Types.ObjectId(userId) },
          { $set: { upiId }, $setOnInsert: { userId: new Types.ObjectId(userId) } },
          { upsert: true },
        )
        .exec();
    }
    return settlement;
  }

  /** The payer's claim that money went out. Does not close the row. */
  async markSent(settlementId: string, userId: string): Promise<SettlementDocument> {
    const { settlement, gg } = await this.loadSettlement(settlementId);

    if (SettlementService.payerOf(settlement) !== userId) {
      throw new AppException(ErrorCode.FORBIDDEN, 'Only the payer can mark this sent', 403);
    }
    if (settlement.status !== SettlementStatus.PENDING) {
      throw new AppException(
        ErrorCode.INVALID_GIFT_TRANSITION,
        `Cannot mark a ${settlement.status} settlement as sent`,
        409,
      );
    }
    if (!settlement.upiId) {
      // The frames gate on this too: `4099:1199` chases missing UPI IDs before
      // `4099:936` unlocks sending.
      throw new AppException(
        ErrorCode.VALIDATION_FAILED,
        'No UPI ID has been shared for this settlement yet',
        409,
      );
    }

    const sentAt = new Date();
    settlement.status = SettlementStatus.SENT;
    settlement.sentAt = sentAt;
    await settlement.save();
    // The receiver is asked to confirm it landed.
    this.emitter.emit(SETTLEMENT_SENT, {
      ...SettlementService.rowEvent(settlement, gg),
      sentAt,
    } satisfies SettlementSentEvent);
    return settlement;
  }

  /**
   * The receiver confirming it landed (`4095:1036`). This is what closes it.
   *
   * Allowed from `pending` as well as `sent`: people pay each other over UPI
   * without touching the app, and a receiver who has the money should not be
   * blocked because the payer never pressed a button.
   */
  async confirmReceived(settlementId: string, userId: string): Promise<SettlementDocument> {
    const { settlement, gg } = await this.loadSettlement(settlementId);

    if (SettlementService.receiverOf(settlement) !== userId) {
      throw new AppException(ErrorCode.FORBIDDEN, 'Only the receiver can confirm this', 403);
    }
    if (settlement.status === SettlementStatus.CONFIRMED) return settlement;
    if (settlement.status === SettlementStatus.CANCELLED) {
      throw new AppException(
        ErrorCode.INVALID_GIFT_TRANSITION,
        'This settlement was cancelled',
        409,
      );
    }

    const confirmedAt = new Date();
    settlement.status = SettlementStatus.CONFIRMED;
    settlement.confirmedAt = confirmedAt;
    await settlement.save();
    // The payer is told it is done.
    this.emitter.emit(SETTLEMENT_CONFIRMED, {
      ...SettlementService.rowEvent(settlement, gg),
      confirmedAt,
    } satisfies SettlementConfirmedEvent);

    // A confirmed top-up is money the host now holds, so it becomes collected
    // — which is what moves the balance back to zero.
    if (settlement.direction === SettlementDirection.TOP_UP) {
      await this.creditTopUp(settlement);
    }
    // And a confirmed refund is money the host no longer holds. Left counted,
    // a price that rose after the refund found the gift "fully funded" on
    // money that had already gone back, and asked nobody for more.
    if (settlement.direction === SettlementDirection.RETURN) {
      await this.groupGifts
        .updateOne(
          { _id: settlement.groupGiftId },
          { $inc: { collectedAmountMinor: -settlement.amountMinor } },
        )
        .exec();
    }
    return settlement;
  }

  /**
   * An admin calling off a settle-up that will not happen — a contributor who
   * left, an amount agreed some other way. Only while it is still open; the
   * note says why, on the settlement itself.
   */
  async cancelAsAdmin(settlementId: string, note: string): Promise<SettlementDocument> {
    const settlement = Types.ObjectId.isValid(settlementId)
      ? await this.settlements.findById(settlementId).exec()
      : null;
    if (!settlement) throw new AppException(ErrorCode.NOT_FOUND, 'Settlement not found', 404);
    if (![SettlementStatus.PENDING, SettlementStatus.SENT].includes(settlement.status)) {
      throw new AppException(
        ErrorCode.VALIDATION_FAILED,
        `A ${settlement.status} settlement cannot be cancelled`,
        409,
      );
    }
    settlement.status = SettlementStatus.CANCELLED;
    settlement.note = note;
    await settlement.save();
    return settlement;
  }

  async listForGroupGift(groupGiftId: string, viewerId?: string): Promise<SettlementDocument[]> {
    if (viewerId !== undefined) {
      await this.assertInTheGroup(await this.load(groupGiftId), viewerId);
    }
    return this.settlements
      .find({ groupGiftId: new Types.ObjectId(groupGiftId) })
      .sort({ createdAt: 1 })
      .exec();
  }

  // ── internals ─────────────────────────────────────────────────────────────

  /**
   * On a `return` the host pays; on a `top_up` the contributor does. Everything
   * about who may act keys off these two, so they live in one place rather than
   * being re-derived at each call site.
   */
  private static payerOf(settlement: SettlementDocument): string {
    return settlement.direction === SettlementDirection.RETURN
      ? settlement.hostId.toString()
      : settlement.contributorId.toString();
  }

  private static receiverOf(settlement: SettlementDocument): string {
    return settlement.direction === SettlementDirection.RETURN
      ? settlement.contributorId.toString()
      : settlement.hostId.toString();
  }

  /**
   * What every settlement notification says about the row it concerns. The
   * payer and the receiver are worked out here once, as everything else is.
   */
  private static rowEvent(
    settlement: SettlementDocument,
    gg: GroupGiftDocument,
  ): SettlementRowEvent {
    return {
      settlementId: settlement._id.toString(),
      groupGiftId: gg._id.toString(),
      title: gg.title,
      direction: settlement.direction,
      payerId: SettlementService.payerOf(settlement),
      receiverId: SettlementService.receiverOf(settlement),
      amountMinor: settlement.amountMinor,
      currency: settlement.currency,
    };
  }

  /**
   * [rows] is every settlement asked for, existing ones included; [fresh] is
   * only those this call created, each of which tells its payer. A row that
   * was already open was told about when it was raised.
   */
  private async raise(
    gg: GroupGiftDocument,
    direction: SettlementDirection,
    allocations: { contributorId: string; amountMinor: number }[],
    note: string | null,
  ): Promise<{ rows: SettlementDocument[]; fresh: SettlementDocument[] }> {
    const positive = allocations.filter((a) => a.amountMinor > 0);

    // Pre-fill from the saved profile UPI so a contributor who has one is
    // already "UPI Available" on `4099:1199` rather than being chased.
    const profiles = await this.profiles
      .find({ userId: { $in: positive.map((a) => new Types.ObjectId(a.contributorId)) } })
      .select('userId upiId')
      .exec();
    const savedUpi = new Map(profiles.map((p) => [p.userId.toString(), p.upiId]));

    const created: SettlementDocument[] = [];
    const fresh: SettlementDocument[] = [];
    for (const allocation of positive) {
      // The partial unique index refuses a second open settlement for the same
      // person and direction; treat that as "already raised" rather than an
      // error, so a double-tap on Send Request is harmless.
      try {
        const row = await this.settlements.create({
          groupGiftId: gg._id,
          contributorId: new Types.ObjectId(allocation.contributorId),
          hostId: gg.initiatorId,
          direction,
          amountMinor: allocation.amountMinor,
          currency: gg.currency,
          status: SettlementStatus.PENDING,
          upiId:
            direction === SettlementDirection.RETURN
              ? (savedUpi.get(allocation.contributorId) ?? null)
              : null,
          note,
        });
        created.push(row);
        fresh.push(row);
      } catch (err) {
        const existing = await this.settlements
          .findOne({
            groupGiftId: gg._id,
            contributorId: new Types.ObjectId(allocation.contributorId),
            direction,
            status: { $in: [SettlementStatus.PENDING, SettlementStatus.SENT] },
          })
          .exec();
        if (!existing) throw err;
        created.push(existing);
      }
    }
    // Whoever pays is told what they owe, and to whom.
    for (const row of fresh) {
      this.emitter.emit(SETTLEMENT_RAISED, {
        ...SettlementService.rowEvent(row, gg),
        note,
      } satisfies SettlementRaisedEvent);
    }
    return { rows: created, fresh };
  }

  /**
   * Records a confirmed top-up as collected money.
   *
   * It is written as a contribution, because that is what it is — this person
   * handed the host money towards the gift — and because contributions are the
   * one record `collectedAmountMinor`, the balance and the nightly reconciler
   * are all derived from. Writing only the settlement left the target raised
   * and the collection untouched, so a topped-up group sat in shortfall for
   * ever and the progress bar never reached full.
   *
   * The settlement's own id is the idempotency key, so the unique
   * `(groupGiftId, idempotencyKey)` index makes a re-confirmation a no-op
   * rather than a second credit.
   */
  private async creditTopUp(settlement: SettlementDocument): Promise<void> {
    await this.credit({
      groupGiftId: settlement.groupGiftId,
      userId: settlement.contributorId,
      amountMinor: settlement.amountMinor,
      key: `settlement:${settlement._id.toString()}`,
    });
  }

  /**
   * Records money the host now holds as a confirmed contribution.
   *
   * Shared by a member's confirmed top-up and the host's own share of one:
   * both are somebody putting money towards the gift, and contributions are
   * the one record the collected total, the balance and the nightly
   * reconciler all come from. [key] is the idempotency key, so crediting the
   * same thing twice is a no-op rather than a second credit.
   */
  private async credit(input: {
    groupGiftId: Types.ObjectId;
    userId: Types.ObjectId;
    amountMinor: number;
    key: string;
  }): Promise<void> {
    try {
      await this.contributions.create({
        groupGiftId: input.groupGiftId,
        userId: input.userId,
        amountMinor: input.amountMinor,
        status: ContributionStatus.CONFIRMED,
        anonymous: false,
        message: null,
        idempotencyKey: input.key,
      });
    } catch (err) {
      // Already credited.
      if ((err as { code?: number })?.code === 11000) return;
      throw err;
    }

    // First money from this person? Then they are a new contributor, counted
    // the same way `contribute` counts one.
    const prior = await this.contributions
      .countDocuments({
        groupGiftId: input.groupGiftId,
        userId: input.userId,
        status: ContributionStatus.CONFIRMED,
        idempotencyKey: { $ne: input.key },
      })
      .exec();

    await this.groupGifts
      .updateOne(
        { _id: input.groupGiftId },
        {
          $inc: {
            collectedAmountMinor: input.amountMinor,
            ...(prior === 0 ? { contributorCount: 1 } : {}),
          },
          $addToSet: { participantIds: input.userId },
        },
      )
      .exec();

    // Full again once the last share lands, so the group stops asking for
    // money it no longer needs. One atomic write that only matches a gift
    // still collecting and now at its goal, so two shares landing together
    // fund it once — and it is announced like any other funding, counted.
    const funded = await this.groupGifts
      .findOneAndUpdate(
        {
          _id: input.groupGiftId,
          status: { $in: DECIDABLE_GROUP_GIFT_STATUSES },
          targetAmountMinor: { $gt: 0 },
          $expr: { $gte: ['$collectedAmountMinor', '$targetAmountMinor'] },
        },
        withFunded({}, { at: new Date(), by: 'system:funded', note: 'topped up' }),
        { new: true },
      )
      .exec();
    if (funded) {
      this.emitter.emit(GROUP_GIFT_FUNDED, {
        groupGiftId: funded._id.toString(),
        itemId: funded.itemId.toString(),
        wishlistId: funded.wishlistId.toString(),
        initiatorId: funded.initiatorId.toString(),
        targetAmountMinor: funded.targetAmountMinor,
        collectedAmountMinor: funded.collectedAmountMinor,
        currency: funded.currency,
        contributorCount: funded.contributorCount,
        fundedCount: funded.fundedCount ?? 1,
      } satisfies GroupGiftFundedEvent);
    }
  }

  /**
   * Who may see what a group owes: its host, its members, and anyone who has
   * put money in. It was every signed-in caller, which handed a stranger the
   * group's whole money position.
   */
  private async assertInTheGroup(gg: GroupGiftDocument, userId: string): Promise<void> {
    const isHost = gg.initiatorId.toString() === userId;
    const isMember = gg.participantIds.some((id) => id.toString() === userId);
    if (isHost || isMember) return;

    const contributed = await this.contributions
      .exists({ groupGiftId: gg._id, userId: new Types.ObjectId(userId) })
      .exec();
    if (contributed) return;

    throw new AppException(ErrorCode.FORBIDDEN, 'This group gift is not yours to see', 403);
  }

  private async load(groupGiftId: string): Promise<GroupGiftDocument> {
    if (!Types.ObjectId.isValid(groupGiftId)) {
      throw new AppException(ErrorCode.GROUP_GIFT_NOT_FOUND, 'Group gift not found', 404);
    }
    const gg = await this.groupGifts.findById(groupGiftId).exec();
    if (!gg) {
      throw new AppException(ErrorCode.GROUP_GIFT_NOT_FOUND, 'Group gift not found', 404);
    }
    return gg;
  }

  /**
   * A settlement to act on — never one on a cancelled gift, which nothing
   * about changes any more. Cancelling already counted every payment as
   * refunded.
   */
  private async loadSettlement(
    settlementId: string,
  ): Promise<{ settlement: SettlementDocument; gg: GroupGiftDocument }> {
    if (!Types.ObjectId.isValid(settlementId)) {
      throw new AppException(ErrorCode.NOT_FOUND, 'Settlement not found', 404);
    }
    const settlement = await this.settlements.findById(settlementId).exec();
    if (!settlement) {
      throw new AppException(ErrorCode.NOT_FOUND, 'Settlement not found', 404);
    }
    const gg = await this.load(settlement.groupGiftId.toString());
    SettlementService.assertActive(gg);
    return { settlement, gg };
  }

  private static assertActive(gg: GroupGiftDocument): void {
    if (INACTIVE_GROUP_GIFT_STATUSES.includes(gg.status)) {
      throw new AppException(ErrorCode.GROUP_GIFT_NOT_OPEN, 'This group gift was cancelled', 409);
    }
  }

  private assertHost(gg: GroupGiftDocument, userId: string): void {
    if (gg.initiatorId.toString() !== userId) {
      throw new AppException(ErrorCode.FORBIDDEN, 'Only the initiator can do this', 403);
    }
  }
}
