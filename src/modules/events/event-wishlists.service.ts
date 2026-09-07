import { Inject, Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  EVENT_WISHLIST_ANSWERED,
  EVENT_WISHLIST_OFFERED,
  type EventWishlistAnsweredEvent,
  type EventWishlistOfferedEvent,
} from 'src/common/events/domain-events';
import { AppException } from 'src/common/errors/app.exception';
import { ErrorCode } from 'src/common/errors/error-codes';
import {
  EVENT_PARTICIPATION,
  type IEventParticipation,
} from 'src/modules/wishlists/access/event-participation.port';
import { Wishlist, type WishlistDocument } from 'src/modules/wishlists/schemas/wishlist.schema';
import {
  UserProfile,
  type UserProfileDocument,
} from 'src/modules/profile/schemas/user-profile.schema';
import { UsersService } from 'src/modules/users/users.service';
import { EventsService } from './events.service';
import {
  EventWishlistSubmission,
  EventWishlistSubmissionStatus,
  type EventWishlistSubmissionDocument,
} from './schemas/event-wishlist-submission.schema';

/** One offer, as either side sees it. */
export interface EventWishlistSubmissionView {
  id: string;
  eventId: string;
  wishlistId: string;
  wishlistTitle: string;
  /** How many items are on it — the host is deciding whether to show it. */
  itemCount: number;
  requestedById: string;
  requestedByName: string;
  status: EventWishlistSubmissionStatus;
  createdAt: Date;
}

/**
 * Guests offering their own wishlists to an event, and the host's answer.
 *
 * The host's own lists reach an event through `Event.wishlistIds`, which stays
 * host-only. A guest's list is linked the other way round — by `eventId` on the
 * list itself — so approving one cannot disturb the host's curated row.
 *
 * Approval links; it never publishes. The list keeps whatever visibility its
 * owner gave it: a public one is openable from the invitation, a private one
 * shows there as a locked row so guests know it exists and nothing more. The
 * typical offer is a surprise list a guest made *for* the host, and the host
 * approving it must not be the thing that lets the host — or anyone the owner
 * did not pick — read it.
 */
@Injectable()
export class EventWishlistsService {
  private readonly logger = new Logger(EventWishlistsService.name);

  constructor(
    @InjectModel(EventWishlistSubmission.name)
    private readonly model: Model<EventWishlistSubmissionDocument>,
    @InjectModel(Wishlist.name)
    private readonly wishlists: Model<WishlistDocument>,
    @InjectModel(UserProfile.name)
    private readonly profiles: Model<UserProfileDocument>,
    private readonly events: EventsService,
    // The same port the access policy uses to answer "is this person going?",
    // rather than a second reading of the invite collection.
    @Inject(EVENT_PARTICIPATION)
    private readonly participation: IEventParticipation,
    private readonly users: UsersService,
    private readonly emitter: EventEmitter2,
  ) {}

  /**
   * What to call these people.
   *
   * Profile display name first, the account's `name` only as a fallback: the
   * phone signup the app uses never sets the latter, so reading it alone names
   * every guest "A friend".
   */
  private async resolveNames(ids: string[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map();
    const [userDocs, profiles] = await Promise.all([
      this.users.findManyByIds(unique),
      this.profiles.find({ userId: { $in: unique.map((id) => new Types.ObjectId(id)) } }).exec(),
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
   * Offers one of the caller's wishlists to an event they are going to.
   *
   * Accepted invitees only. Being invited is not the same as coming, and a
   * list on the invitation from someone who then does not turn up is a list
   * the host has to explain to everyone who did.
   */
  async submit(
    eventId: string,
    userId: string,
    wishlistId: string,
  ): Promise<EventWishlistSubmissionView> {
    const event = await this.events.findOrFail(eventId);
    if (!(await this.participation.isAcceptedInvitee(event._id, userId))) {
      // 404 rather than 403: someone not going has no business learning that
      // this event exists.
      throw new AppException(ErrorCode.EVENT_NOT_FOUND, 'Event not found', 404);
    }

    const wishlist = await this.loadOwnedListOrFail(wishlistId, userId);
    if (wishlist.eventId) {
      throw new AppException(
        ErrorCode.VALIDATION_FAILED,
        wishlist.eventId.toString() === event._id.toString()
          ? 'This wishlist is already on this event'
          : 'This wishlist already belongs to another event',
        409,
      );
    }

    try {
      const submission = await this.model.create({
        eventId: event._id,
        wishlistId: wishlist._id,
        requestedById: new Types.ObjectId(userId),
        status: EventWishlistSubmissionStatus.PENDING,
      });
      this.logger.log(`Wishlist ${wishlistId} offered to event ${eventId} by ${userId}`);
      const names = await this.resolveNames([userId]);

      // The host's queue sits at the foot of one event's page. Without this
      // the offer waits there unseen: the host is never told it arrived, and
      // the guest is never told why their list is not on the invitation.
      this.emitter.emit(EVENT_WISHLIST_OFFERED, {
        eventId,
        submissionId: submission._id.toString(),
        hostId: event.hostId.toString(),
        guestName: names.get(userId) ?? 'A guest',
        eventTitle: event.title,
        wishlistTitle: wishlist.title,
      } satisfies EventWishlistOfferedEvent);

      return this.toView(submission, wishlist, names.get(userId));
    } catch {
      // Either index caught it: the same list offered to this event twice, or
      // offered elsewhere while still waiting.
      throw new AppException(
        ErrorCode.VALIDATION_FAILED,
        'This wishlist has already been offered to an event',
        409,
      );
    }
  }

  /** The host's queue for one event. */
  async listForHost(eventId: string, userId: string): Promise<EventWishlistSubmissionView[]> {
    const event = await this.events.findOwnedOrFail(eventId, userId);
    const submissions = await this.model
      .find({
        eventId: event._id,
        status: {
          $in: [EventWishlistSubmissionStatus.PENDING, EventWishlistSubmissionStatus.APPROVED],
        },
      })
      .sort({ createdAt: -1 })
      .limit(100)
      .exec();
    return this.withLists(submissions);
  }

  /** The caller's own offers, so a guest can see what is still waiting. */
  async listMine(userId: string): Promise<EventWishlistSubmissionView[]> {
    const submissions = await this.model
      .find({
        requestedById: new Types.ObjectId(userId),
        status: {
          $in: [EventWishlistSubmissionStatus.PENDING, EventWishlistSubmissionStatus.APPROVED],
        },
      })
      .sort({ createdAt: -1 })
      .limit(100)
      .exec();
    return this.withLists(submissions);
  }

  /**
   * The host's answer.
   *
   * Approving links the list to the event and nothing else. Its visibility is
   * the owner's, and stays theirs: the invitation shows a private list as a
   * locked row rather than opening it, so the host approving a surprise list
   * made for them does not hand them — or the whole guest list — its contents.
   */
  async respond(
    eventId: string,
    submissionId: string,
    userId: string,
    approve: boolean,
  ): Promise<EventWishlistSubmissionView> {
    const event = await this.events.findOwnedOrFail(eventId, userId);
    const submission = await this.loadOrFail(submissionId, event._id);
    if (submission.status !== EventWishlistSubmissionStatus.PENDING) {
      throw new AppException(
        ErrorCode.VALIDATION_FAILED,
        'This wishlist has already been answered',
        409,
      );
    }

    const wishlist = await this.wishlists.findById(submission.wishlistId).exec();
    if (!wishlist || wishlist.archivedAt) {
      throw new AppException(ErrorCode.WISHLIST_NOT_FOUND, 'Wishlist not found', 404);
    }

    // Told either way. Offering a list used to end in silence whichever way
    // the host decided, so a guest had no way to know it had been answered.
    const announce = (approved: boolean): void => {
      this.emitter.emit(EVENT_WISHLIST_ANSWERED, {
        eventId,
        submissionId: submission._id.toString(),
        guestId: submission.requestedById.toString(),
        eventTitle: event.title,
        wishlistTitle: wishlist.title,
        approved,
      } satisfies EventWishlistAnsweredEvent);
    };

    if (!approve) {
      submission.status = EventWishlistSubmissionStatus.REJECTED;
      submission.respondedAt = new Date();
      await submission.save();
      announce(false);
      return this.toView(submission, wishlist);
    }

    // Re-checked here, not just at submission: the owner may have attached it
    // somewhere else while this sat in the queue.
    if (wishlist.eventId) {
      throw new AppException(
        ErrorCode.VALIDATION_FAILED,
        'This wishlist already belongs to another event',
        409,
      );
    }

    wishlist.eventId = event._id;
    await wishlist.save();

    submission.status = EventWishlistSubmissionStatus.APPROVED;
    submission.respondedAt = new Date();
    await submission.save();
    this.logger.log(`Wishlist ${wishlist._id.toString()} approved onto event ${eventId}`);
    announce(true);
    return this.toView(submission, wishlist);
  }

  /**
   * Takes an approved list back off the event.
   *
   * Either side may: the host curates the event, and the owner must not be
   * trapped into showing a list they have changed their mind about. Only the
   * link goes; the list's visibility was never touched.
   */
  async remove(
    eventId: string,
    submissionId: string,
    userId: string,
  ): Promise<EventWishlistSubmissionView> {
    const event = await this.events.findOrFail(eventId);
    const submission = await this.loadOrFail(submissionId, event._id);

    const isHost = event.hostId.toString() === userId;
    const isOwner = submission.requestedById.toString() === userId;
    if (!isHost && !isOwner) {
      throw new AppException(ErrorCode.NOT_FOUND, 'Wishlist request not found', 404);
    }
    if (
      submission.status !== EventWishlistSubmissionStatus.APPROVED &&
      submission.status !== EventWishlistSubmissionStatus.PENDING
    ) {
      throw new AppException(ErrorCode.VALIDATION_FAILED, 'This wishlist is not on the event', 409);
    }

    const wishlist = await this.wishlists.findById(submission.wishlistId).exec();
    if (wishlist && submission.status === EventWishlistSubmissionStatus.APPROVED) {
      wishlist.eventId = null;
      await wishlist.save();
    }

    submission.status = EventWishlistSubmissionStatus.REMOVED;
    submission.respondedAt = new Date();
    await submission.save();
    return this.toView(submission, wishlist ?? undefined);
  }

  private async loadOrFail(
    submissionId: string,
    eventId: Types.ObjectId,
  ): Promise<EventWishlistSubmissionDocument> {
    if (!Types.ObjectId.isValid(submissionId)) {
      throw new AppException(ErrorCode.NOT_FOUND, 'Wishlist request not found', 404);
    }
    const submission = await this.model.findById(submissionId).exec();
    if (!submission || submission.eventId.toString() !== eventId.toString()) {
      throw new AppException(ErrorCode.NOT_FOUND, 'Wishlist request not found', 404);
    }
    return submission;
  }

  private async loadOwnedListOrFail(wishlistId: string, userId: string): Promise<WishlistDocument> {
    if (!Types.ObjectId.isValid(wishlistId)) {
      throw new AppException(ErrorCode.WISHLIST_NOT_FOUND, 'Wishlist not found', 404);
    }
    const wishlist = await this.wishlists.findById(wishlistId).exec();
    // Only your own list, and 404 for anyone else's — a wishlist id must not be
    // probeable through this endpoint.
    if (!wishlist || wishlist.archivedAt || wishlist.ownerId.toString() !== userId) {
      throw new AppException(ErrorCode.WISHLIST_NOT_FOUND, 'Wishlist not found', 404);
    }
    return wishlist;
  }

  private async withLists(
    submissions: EventWishlistSubmissionDocument[],
  ): Promise<EventWishlistSubmissionView[]> {
    if (submissions.length === 0) return [];
    const lists = await this.wishlists
      .find({ _id: { $in: submissions.map((s) => s.wishlistId) } })
      .exec();
    const byId = new Map(lists.map((w) => [w._id.toString(), w]));
    const names = await this.resolveNames(submissions.map((s) => s.requestedById.toString()));
    return submissions.map((s) =>
      this.toView(s, byId.get(s.wishlistId.toString()), names.get(s.requestedById.toString())),
    );
  }

  private toView(
    submission: EventWishlistSubmissionDocument,
    wishlist?: WishlistDocument,
    requestedByName?: string,
  ): EventWishlistSubmissionView {
    return {
      id: submission._id.toString(),
      eventId: submission.eventId.toString(),
      wishlistId: submission.wishlistId.toString(),
      // A deleted list is still listed rather than dropped, so the host can see
      // why a row went away instead of the queue silently shrinking.
      wishlistTitle: wishlist?.title ?? 'A wishlist',
      itemCount: wishlist?.stats?.itemCount ?? 0,
      requestedById: submission.requestedById.toString(),
      requestedByName: requestedByName ?? 'A friend',
      status: submission.status,
      createdAt: submission.createdAt,
    };
  }
}
