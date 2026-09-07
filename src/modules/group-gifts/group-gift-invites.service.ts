import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { AppException } from 'src/common/errors/app.exception';
import { ErrorCode } from 'src/common/errors/error-codes';
import { GROUP_GIFT_INVITED, type GroupGiftInvitedEvent } from 'src/common/events/domain-events';
import { ParticipantsService } from 'src/modules/wishlists/participants.service';
import { ParticipantRole } from 'src/modules/wishlists/wishlist.types';
import {
  UserProfile,
  type UserProfileDocument,
} from 'src/modules/profile/schemas/user-profile.schema';
import { UsersService } from 'src/modules/users/users.service';
import {
  WishlistItem,
  type WishlistItemDocument,
} from 'src/modules/wishlists/schemas/wishlist-item.schema';
import { WishmatesService } from 'src/modules/wishmates/wishmates.service';
import { WishmateRelationship } from 'src/modules/wishmates/wishmates.views';
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
    @InjectModel(UserProfile.name)
    private readonly profileModel: Model<UserProfileDocument>,
    private readonly users: UsersService,
    private readonly gifts: GroupGiftService,
    private readonly wishmates: WishmatesService,
    private readonly participants: ParticipantsService,
    private readonly emitter: EventEmitter2,
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
        await this.model.create({
          groupGiftId: gift._id,
          invitedUserId: new Types.ObjectId(raw),
          invitedById: new Types.ObjectId(userId),
          status: GroupGiftInviteStatus.PENDING,
        });
        invited++;
        this.emitter.emit(GROUP_GIFT_INVITED, {
          groupGiftId,
          invitedUserId: raw,
          invitedById: userId,
        } satisfies GroupGiftInvitedEvent);
      } catch {
        // The unique index caught a duplicate — someone already asked them.
        skipped++;
      }
    }

    this.logger.log(`Group gift ${groupGiftId}: ${invited} invited, ${skipped} skipped`);
    return { invited, skipped };
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

    return {
      ...toView(invite, gift, names),
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
   * What to call these people.
   *
   * Profile display name first, the account's `name` only as a fallback — the
   * phone signup the app uses never sets the latter, so reading it alone names
   * everybody "A friend".
   */
  private async resolveNames(ids: string[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map();
    const objectIds = unique.map((id) => new Types.ObjectId(id));
    const [userDocs, profiles] = await Promise.all([
      this.users.findManyByIds(unique),
      this.profileModel.find({ userId: { $in: objectIds } }).exec(),
    ]);
    const names = new Map<string, string>();
    for (const u of userDocs) {
      const name = u.name?.trim();
      if (name) names.set(u._id.toString(), name);
    }
    for (const p of profiles) {
      const name = p.displayName?.trim();
      if (name) names.set(p.userId.toString(), name);
    }
    return names;
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
