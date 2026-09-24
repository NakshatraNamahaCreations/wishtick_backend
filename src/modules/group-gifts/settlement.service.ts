import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { AppException } from 'src/common/errors/app.exception';
import { ErrorCode } from 'src/common/errors/error-codes';
import {
  UserProfile,
  type UserProfileDocument,
} from 'src/modules/profile/schemas/user-profile.schema';
import {
  ContributionStatus,
  GroupGiftStatus,
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

@Injectable()
export class SettlementService {
  constructor(
    @InjectModel(GroupGift.name) private readonly groupGifts: Model<GroupGiftDocument>,
    @InjectModel(Contribution.name) private readonly contributions: Model<ContributionDocument>,
    @InjectModel(Settlement.name) private readonly settlements: Model<SettlementDocument>,
    @InjectModel(UserProfile.name) private readonly profiles: Model<UserProfileDocument>,
  ) {}

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
   * The host returns a surplus.
   *
   * Only the host may raise these: the amounts decide what the host is publicly
   * on the hook for, and a contributor being able to mint their own refund
   * would be an obvious abuse.
   */
  async distributeReturn(
    groupGiftId: string,
    hostId: string,
    input: { custom?: { contributorId: string; amountMinor: number }[]; note?: string },
  ): Promise<SettlementDocument[]> {
    const gg = await this.load(groupGiftId);
    this.assertHost(gg, hostId);

    const balance = await this.balance(groupGiftId);
    if (balance.differenceMinor <= 0) {
      throw new AppException(
        ErrorCode.CONTRIBUTION_AMOUNT_INVALID,
        'There is no surplus to return',
        409,
      );
    }

    const contributors = await this.confirmedContributorIds(gg._id);
    if (contributors.length === 0) {
      throw new AppException(
        ErrorCode.CONTRIBUTION_AMOUNT_INVALID,
        'Nobody has contributed yet',
        409,
      );
    }

    const allocations = input.custom
      ? input.custom.map((c) => ({ contributorId: c.contributorId, amountMinor: c.amountMinor }))
      : SettlementService.splitEvenly(balance.differenceMinor, contributors.length).map(
          (amountMinor, i) => ({ contributorId: contributors[i], amountMinor }),
        );

    const total = allocations.reduce((sum, a) => sum + a.amountMinor, 0);
    if (total > balance.differenceMinor) {
      throw new AppException(
        ErrorCode.CONTRIBUTION_AMOUNT_INVALID,
        'The split is larger than the surplus',
        409,
      );
    }

    return this.raise(gg, SettlementDirection.RETURN, allocations, input.note ?? null);
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

    if (input.additionalAmountMinor <= 0) {
      throw new AppException(
        ErrorCode.CONTRIBUTION_AMOUNT_INVALID,
        'A contribution request needs a positive amount',
        400,
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
    return this.raise(gg, SettlementDirection.TOP_UP, allocations, input.note ?? null);
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
    const settlement = await this.loadSettlement(settlementId);
    const receiverId = SettlementService.receiverOf(settlement);

    if (receiverId !== userId) {
      throw new AppException(
        ErrorCode.FORBIDDEN,
        'Only the person being paid can share a UPI ID',
        403,
      );
    }

    settlement.upiId = upiId;
    await settlement.save();

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
    const settlement = await this.loadSettlement(settlementId);

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

    settlement.status = SettlementStatus.SENT;
    settlement.sentAt = new Date();
    await settlement.save();
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
    const settlement = await this.loadSettlement(settlementId);

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

    settlement.status = SettlementStatus.CONFIRMED;
    settlement.confirmedAt = new Date();
    await settlement.save();

    // A confirmed top-up is money the host now holds, so it becomes collected
    // — which is what moves the balance back to zero.
    if (settlement.direction === SettlementDirection.TOP_UP) {
      await this.creditTopUp(settlement);
    }
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

  private async raise(
    gg: GroupGiftDocument,
    direction: SettlementDirection,
    allocations: { contributorId: string; amountMinor: number }[],
    note: string | null,
  ): Promise<SettlementDocument[]> {
    const positive = allocations.filter((a) => a.amountMinor > 0);

    // Pre-fill from the saved profile UPI so a contributor who has one is
    // already "UPI Available" on `4099:1199` rather than being chased.
    const profiles = await this.profiles
      .find({ userId: { $in: positive.map((a) => new Types.ObjectId(a.contributorId)) } })
      .select('userId upiId')
      .exec();
    const savedUpi = new Map(profiles.map((p) => [p.userId.toString(), p.upiId]));

    const created: SettlementDocument[] = [];
    for (const allocation of positive) {
      // The partial unique index refuses a second open settlement for the same
      // person and direction; treat that as "already raised" rather than an
      // error, so a double-tap on Send Request is harmless.
      try {
        created.push(
          await this.settlements.create({
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
          }),
        );
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
    return created;
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
    // money it no longer needs.
    const gg = await this.groupGifts.findById(input.groupGiftId).exec();
    if (
      gg &&
      gg.status === GroupGiftStatus.OPEN &&
      gg.collectedAmountMinor >= gg.targetAmountMinor
    ) {
      gg.status = GroupGiftStatus.FUNDED;
      gg.history.push({
        status: GroupGiftStatus.FUNDED,
        at: new Date(),
        by: 'system:funded',
        note: 'topped up',
      });
      await gg.save();
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

  private async confirmedContributorIds(groupGiftId: Types.ObjectId): Promise<string[]> {
    const rows = await this.contributions
      .find({ groupGiftId, status: ContributionStatus.CONFIRMED })
      .sort({ createdAt: 1 })
      .exec();
    // Distinct, oldest first — the split's remainder paise go to whoever
    // contributed earliest, which is at least a rule rather than a coin toss.
    return [...new Set(rows.map((r) => r.userId.toString()))];
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

  private async loadSettlement(settlementId: string): Promise<SettlementDocument> {
    if (!Types.ObjectId.isValid(settlementId)) {
      throw new AppException(ErrorCode.NOT_FOUND, 'Settlement not found', 404);
    }
    const settlement = await this.settlements.findById(settlementId).exec();
    if (!settlement) {
      throw new AppException(ErrorCode.NOT_FOUND, 'Settlement not found', 404);
    }
    return settlement;
  }

  private assertHost(gg: GroupGiftDocument, userId: string): void {
    if (gg.initiatorId.toString() !== userId) {
      throw new AppException(ErrorCode.FORBIDDEN, 'Only the initiator can do this', 403);
    }
  }
}
