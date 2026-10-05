import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { AppException } from 'src/common/errors/app.exception';
import { ErrorCode } from 'src/common/errors/error-codes';
import { GROUP_GIFT_INVITED, type GroupGiftInvitedEvent } from 'src/common/events/domain-events';
import { ParticipantsService } from 'src/modules/wishlists/participants.service';
import { ParticipantRole } from 'src/modules/wishlists/wishlist.types';
import { UsersService } from 'src/modules/users/users.service';
import {
  WishlistItem,
  type WishlistItemDocument,
} from 'src/modules/wishlists/schemas/wishlist-item.schema';
import { WishmatesService } from 'src/modules/wishmates/wishmates.service';
import { WishmateRelationship } from 'src/modules/wishmates/wishmates.views';
import type { EqualSplitView } from './group-gift.views';
import { GroupGiftShareService } from './group-gift-share.service';
import { GroupGiftService } from './group-gift.service';
import { CLOSED_GROUP_GIFT_STATUSES, ContributionStatus } from './group-gift.types';
import {
  GroupGiftInvite,
  GroupGiftInviteStatus,
  type GroupGiftInviteDocument,
} from './schemas/group-gift-invite.schema';
import { Contribution, type ContributionDocument } from './schemas/contribution.schema';
import { GroupGift, type GroupGiftDocument } from './schemas/group-gift.schema';

/** One invitation, as the invitee's list shows it. */
export interface GroupGiftInviteView {
  id: string;
  groupGiftId: string;
  groupTitle: string;
  status: GroupGiftInviteStatus;
  invitedById: string;
  /**
   * Who asked. An invitation from nobody in particular is one people ignore,
   * and the id alone cannot be shown to a person.
   */
  inviterName: string;
  createdAt: Date;
}

/** One person who has already put money in. */
export interface InviteContributorView {
  userId: string | null;
  name: string;
  amountMinor: number;
}

/**
 * Everything the invitee needs to answer: what the gift is, how far along the
 * collection is, and who is already in.
 *
 * Deliberately its own view rather than the full [GroupGiftView]. The invitee
 * is not a participant yet and may not even be able to see the wishlist behind
 * the group, so the ordinary read would refuse them — the *invitation* is the
 * authority here, and it grants exactly this much: enough to decide.
 */
export interface GroupGiftInviteDetailView extends GroupGiftInviteView {
  itemTitle: string;
  imageUrl: string | null;
  currency: string;
  targetAmountMinor: number;
  collectedAmountMinor: number;
  percentFunded: number;
  contributorCount: number;
  /** Confirmed contributions, newest first. Anonymous ones keep their name. */
  contributors: InviteContributorView[];
  /** When the money has to be in by, for the "2 days left" line. */
  deadline: Date | null;
  /**
   * Everything the invitee needs to actually pay, without first being let into
   * the group: the chips the contribute sheet offers, and who the money goes
   * to. Paying is how they accept, so it has to be possible from here.
   */
  suggestedAmountsMinor: number[];
  hostName: string;
  hostUpiId: string | null;
  /**
   * For a gift split equally: everybody's share, and the invitee's own — what
   * they are being asked for, before they have said yes.
   */
  split: EqualSplitView | null;
}

const toView = (
  invite: GroupGiftInviteDocument,
  gift: GroupGiftDocument | undefined,
  names: Map<string, string>,
): GroupGiftInviteView => ({
  id: invite._id.toString(),
  groupGiftId: invite.groupGiftId.toString(),
  groupTitle: gift?.title ?? 'A group gift',
  status: invite.status,
  invitedById: invite.invitedById.toString(),
  inviterName: names.get(invite.invitedById.toString()) ?? 'A friend',
  createdAt: invite.createdAt,
});

/**
 * Asking WishMates to chip in, and their answer.
 *
 * Split from [GroupGiftService], which is already the largest service in the
 * codebase and owns the funding state machine. Nothing here touches money.
 */
@Injectable()
export class GroupGiftInvitesService {
  private readonly logger = new Logger(GroupGiftInvitesService.name);

  constructor(
    @InjectModel(GroupGiftInvite.name)
    private readonly model: Model<GroupGiftInviteDocument>,
    @InjectModel(GroupGift.name)
    private readonly giftModel: Model<GroupGiftDocument>,
    // Read-only, and all three are already registered by GroupGiftModule. The
    // invitee cannot go through the ordinary group-gift read — they are not a
    // participant and the wishlist may be private — so the detail view is
    // assembled here, authorised by the invitation itself.
    @InjectModel(WishlistItem.name)
    private readonly itemModel: Model<WishlistItemDocument>,
    @InjectModel(Contribution.name)
    private readonly contributionModel: Model<ContributionDocument>,
    private readonly users: UsersService,
    private readonly gifts: GroupGiftService,
    private readonly wishmates: WishmatesService,
    private readonly participants: ParticipantsService,
    private readonly emitter: EventEmitter2,
    private readonly shares: GroupGiftShareService,
  ) {}

  /**
   * Invites WishMates to a group the caller is already in.
   *
   * Members may invite, not just the initiator: a group gift is a group, and
   * making the one person who started it the only route in is how a collection
   * stalls when they go quiet.
   *
   * Ids that cannot be invited are skipped rather than failing the batch —
   * somebody already asked, already a member, or no longer a WishMate. A picker
   * of several people that refuses wholesale over one stale row is worse than
   * one that invites who it can and says how many.
   */
  async invite(
    groupGiftId: string,
    userId: string,
    userIds: string[],
  ): Promise<{ invited: number; skipped: number }> {
    const gift = await this.loadOpenOrFail(groupGiftId);
    this.assertMember(gift, userId);

    let invited = 0;
    let skipped = 0;
    const added: string[] = [];

    for (const raw of userIds) {
      if (!Types.ObjectId.isValid(raw) || raw === userId) {
        skipped++;
        continue;
      }
      // The gift is a surprise for its recipient; inviting them to fund it
      // would give the whole thing away in a notification.
      if (gift.recipientId.toString() === raw) {
        skipped++;
        continue;
      }
      if (gift.participantIds.some((id) => id.toString() === raw)) {
        skipped++;
        continue;
      }

      // Checked on the server rather than trusted from the picker, for the same
      // reason every other WishMate-only action is.
      const relationship = await this.wishmates.relationshipWith(userId, raw);
      if (relationship !== WishmateRelationship.WISHMATES) {
        skipped++;
        continue;
      }

      try {
        // In by default: an invitation is a place in the group, not a
        // question. The one thing left to the invitee is to say they are
        // not interested — see [leave] — which takes them out again.
        await this.model.create({
          groupGiftId: gift._id,
          invitedUserId: new Types.ObjectId(raw),
          invitedById: new Types.ObjectId(userId),
          status: GroupGiftInviteStatus.ACCEPTED,
          respondedAt: new Date(),
        });
      } catch {
        // The unique index caught a duplicate — someone already asked them.
        skipped++;
        continue;
      }
      // What accepting used to grant: enough of the list to see the gift.
      await this.participants.addForInvite(gift.wishlistId.toString(), raw, ParticipantRole.VIEWER);
      await this.giftModel
        .updateOne({ _id: gift._id }, { $addToSet: { participantIds: new Types.ObjectId(raw) } })
        .exec();
      added.push(raw);
      invited++;
    }

    this.logger.log(`Group gift ${groupGiftId}: ${invited} invited, ${skipped} skipped`);
    if (invited === 0) return { invited, skipped };

    // Everybody added is somebody to share an equal split with: the host's
    // share comes down, and each newcomer's share is what they are told.
    await this.shares.sync(groupGiftId);
    const fresh = await this.giftModel.findById(gift._id).exec();
    const split = fresh ? await this.shares.splitOf(fresh) : null;
    for (const raw of added) {
      this.emitter.emit(GROUP_GIFT_INVITED, {
        groupGiftId,
        invitedUserId: raw,
        invitedById: userId,
        shareMinor: split?.others.find((m) => m.userId === raw)?.shareMinor ?? null,
      } satisfies GroupGiftInvitedEvent);
    }
    return { invited, skipped };
  }

  /**
   * Everyone [invite] would skip without asking WishMate status: the host,
   * the recipient, the members, and anybody with an invitation row — which
   * includes those who left, since the unique index will not ask them twice.
   *
   * For the picker, so it greys these out rather than offering a tap that
   * the server then quietly counts as skipped.
   */
  async alreadyInvited(groupGiftId: string, userId: string): Promise<{ userIds: string[] }> {
    const gift = await this.loadOpenOrFail(groupGiftId);
    this.assertMember(gift, userId);
    const invited = await this.model
      .find({ groupGiftId: gift._id })
      .distinct('invitedUserId')
      .exec();
    const ids = new Set<string>([
      gift.initiatorId.toString(),
      gift.recipientId.toString(),
      ...gift.participantIds.map((id) => id.toString()),
      ...invited.map((id) => id.toString()),
    ]);
    return { userIds: [...ids] };
  }

  /**
   * "Not interested": out of a group gift the caller was added to.
   *
   * Only before they have paid anything — money in is a commitment the rest
   * of the group is counting on, and the way out of that is withdrawing it,
   * which has its own rules. Never the host: it is theirs to cancel, not
   * leave. The invitation, if there was one, is marked declined so it is not
   * offered again, and an equal split is shared again without them.
   */
  async leave(groupGiftId: string, userId: string): Promise<{ left: true }> {
    const gift = await this.loadOpenOrFail(groupGiftId);
    if (gift.initiatorId.toString() === userId) {
      throw new AppException(
        ErrorCode.FORBIDDEN,
        'The host cannot leave their own group gift — cancel it instead',
        403,
      );
    }
    // Only somebody in it can leave it. 404 rather than 403, as everywhere a
    // stranger asks about a group gift: they need not learn it exists.
    const invited = await this.model
      .exists({
        groupGiftId: gift._id,
        invitedUserId: new Types.ObjectId(userId),
        status: { $ne: GroupGiftInviteStatus.DECLINED },
      })
      .exec();
    if (!invited && !gift.participantIds.some((id) => id.toString() === userId)) {
      throw new AppException(ErrorCode.GROUP_GIFT_NOT_FOUND, 'Group gift not found', 404);
    }
    const paid = await this.contributionModel
      .countDocuments({
        groupGiftId: gift._id,
        userId: new Types.ObjectId(userId),
        status: ContributionStatus.CONFIRMED,
      })
      .exec();
    if (paid > 0) {
      throw new AppException(
        ErrorCode.VALIDATION_FAILED,
        'You have already chipped in, so you are part of this one',
        409,
      );
    }

    await this.model
      .updateOne(
        { groupGiftId: gift._id, invitedUserId: new Types.ObjectId(userId) },
        { $set: { status: GroupGiftInviteStatus.DECLINED, respondedAt: new Date() } },
      )
      .exec();
    await this.giftModel
      .updateOne({ _id: gift._id }, { $pull: { participantIds: new Types.ObjectId(userId) } })
      .exec();
    // The list access came with the invitation; saying no takes it back, so
    // "not interested" never leaves them holding somebody's private list.
    await this.participants.removeForInvite(gift.wishlistId.toString(), userId);
    await this.shares.sync(groupGiftId);
    return { left: true };
  }

  /** The caller's own pending invitations, newest first. */
  async listMine(userId: string): Promise<GroupGiftInviteView[]> {
    const invites = await this.model
      .find({
        invitedUserId: new Types.ObjectId(userId),
        status: GroupGiftInviteStatus.PENDING,
      })
      .sort({ createdAt: -1 })
      .limit(50)
      .exec();
    if (invites.length === 0) return [];

    const gifts = await this.giftModel
      .find({ _id: { $in: invites.map((i) => i.groupGiftId) } })
      .exec();
    const byId = new Map(gifts.map((g) => [g._id.toString(), g]));
    const names = await this.resolveNames(invites.map((i) => i.invitedById.toString()));

    return invites.map((invite) => toView(invite, byId.get(invite.groupGiftId.toString()), names));
  }

  /**
   * One invitation, with enough of the gift behind it to answer.
   *
   * The invitation is the authority: someone holding a pending invite may see
   * the item, the total, and who has already chipped in, without being a
   * participant and without any access to the wishlist the group hangs off.
   */
  async detail(inviteId: string, userId: string): Promise<GroupGiftInviteDetailView> {
    const invite = await this.loadOwnedOrFail(inviteId, userId);
    const gift = await this.giftModel.findById(invite.groupGiftId).exec();
    if (!gift) {
      throw new AppException(ErrorCode.GROUP_GIFT_NOT_FOUND, 'Group gift not found', 404);
    }

    const [item, contributions] = await Promise.all([
      this.itemModel.findById(gift.itemId).exec(),
      this.contributionModel
        .find({ groupGiftId: gift._id, status: ContributionStatus.CONFIRMED })
        .sort({ createdAt: -1 })
        .limit(20)
        .exec(),
    ]);

    const names = await this.resolveNames([
      invite.invitedById.toString(),
      gift.initiatorId.toString(),
      ...contributions.filter((c) => !c.anonymous).map((c) => c.userId.toString()),
    ]);

    const others = await this.shares.othersIn(gift);
    const splitNames = await this.resolveNames([gift.initiatorId.toString(), ...others]);
    const split = await this.shares.viewFor(gift, userId, (id) => splitNames.get(id) ?? 'A friend');

    return {
      ...toView(invite, gift, names),
      split,
      itemTitle: item?.title ?? gift.title,
      imageUrl: item?.imageUrls?.[0] ?? null,
      currency: gift.currency,
      targetAmountMinor: gift.targetAmountMinor,
      collectedAmountMinor: gift.collectedAmountMinor,
      percentFunded:
        gift.targetAmountMinor <= 0
          ? 0
          : Math.min(100, Math.round((gift.collectedAmountMinor / gift.targetAmountMinor) * 100)),
      contributorCount: gift.contributorCount,
      deadline: gift.deadline,
      suggestedAmountsMinor: gift.suggestedAmountsMinor ?? [],
      hostName: names.get(gift.initiatorId.toString()) ?? 'A friend',
      hostUpiId: gift.hostUpiId ?? null,
      contributors: contributions.map((c) => ({
        // Anonymity survives the invitation: someone who chose not to be named
        // did not choose to be named to whoever gets asked next.
        userId: c.anonymous ? null : c.userId.toString(),
        name: c.anonymous ? 'Someone' : (names.get(c.userId.toString()) ?? 'A friend'),
        amountMinor: c.amountMinor,
      })),
    };
  }

  /**
   * What to call these people. See [UsersService.displayNamesFor] — this was
   * the same lookup written out here, and the copy of it that notifications
   * used was not the correct one.
   */
  private resolveNames(ids: string[]): Promise<Map<string, string>> {
    return this.users.displayNamesFor(ids);
  }

  /**
   * Accepts or declines.
   *
   * Accepting does two things, and both are needed for it to mean anything:
   * it adds the invitee to the underlying wishlist so they *can* gift from it,
   * and then joins them to the group. Joining alone would fail on a private
   * list — [GroupGiftService.join] resolves the wishlist policy — which is the
   * hole a bare share link left.
   *
   * The wishlist role is VIEWER, the least that grants `canGift`: they were
   * invited to pay towards one item, not into the owner's list chat.
   */
  async respond(inviteId: string, userId: string, accept: boolean): Promise<GroupGiftInviteView> {
    const invite = await this.loadOwnedOrFail(inviteId, userId);
    if (invite.status !== GroupGiftInviteStatus.PENDING) {
      throw new AppException(
        ErrorCode.VALIDATION_FAILED,
        'You have already answered this invitation',
        409,
      );
    }

    const gift = await this.loadOpenOrFail(invite.groupGiftId.toString());

    const names = await this.resolveNames([invite.invitedById.toString()]);

    if (!accept) {
      invite.status = GroupGiftInviteStatus.DECLINED;
      invite.respondedAt = new Date();
      await invite.save();
      // One fewer to share with.
      await this.shares.sync(invite.groupGiftId);
      return toView(invite, gift, names);
    }

    await this.participants.addForInvite(
      gift.wishlistId.toString(),
      userId,
      ParticipantRole.VIEWER,
    );
    await this.gifts.join(invite.groupGiftId.toString(), userId);

    invite.status = GroupGiftInviteStatus.ACCEPTED;
    invite.respondedAt = new Date();
    await invite.save();
    return toView(invite, gift, names);
  }

  private async loadOpenOrFail(groupGiftId: string): Promise<GroupGiftDocument> {
    if (!Types.ObjectId.isValid(groupGiftId)) {
      throw new AppException(ErrorCode.GROUP_GIFT_NOT_FOUND, 'Group gift not found', 404);
    }
    const gift = await this.giftModel.findById(groupGiftId).exec();
    if (!gift) {
      throw new AppException(ErrorCode.GROUP_GIFT_NOT_FOUND, 'Group gift not found', 404);
    }
    if (CLOSED_GROUP_GIFT_STATUSES.includes(gift.status)) {
      throw new AppException(ErrorCode.GROUP_GIFT_CLOSED, 'This group gift is closed', 409);
    }
    return gift;
  }

  private assertMember(gift: GroupGiftDocument, userId: string): void {
    const isMember =
      gift.initiatorId.toString() === userId ||
      gift.participantIds.some((id) => id.toString() === userId);
    if (!isMember) {
      // 404, not 403: someone who is not in the group has no business learning
      // that this group exists.
      throw new AppException(ErrorCode.GROUP_GIFT_NOT_FOUND, 'Group gift not found', 404);
    }
  }

  private async loadOwnedOrFail(
    inviteId: string,
    userId: string,
  ): Promise<GroupGiftInviteDocument> {
    if (!Types.ObjectId.isValid(inviteId)) {
      throw new AppException(ErrorCode.NOT_FOUND, 'Invitation not found', 404);
    }
    const invite = await this.model.findById(inviteId).exec();
    // Addressed to somebody else is a 404 rather than a 403, so an id cannot be
    // probed to learn who was invited to what.
    if (!invite || invite.invitedUserId.toString() !== userId) {
      throw new AppException(ErrorCode.NOT_FOUND, 'Invitation not found', 404);
    }
    return invite;
  }
}
