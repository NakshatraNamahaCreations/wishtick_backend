import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectModel } from '@nestjs/mongoose';
import type { Queue } from 'bullmq';
import { Model, Types } from 'mongoose';
import { customAlphabet } from 'nanoid';
import { AppException } from 'src/common/errors/app.exception';
import { ErrorCode } from 'src/common/errors/error-codes';
import {
  MEMORY_SHARED,
  MEMORY_UNLOCKED,
  MEMORY_WISH_INVITED,
  type MemorySharedEvent,
  type MemoryUnlockedEvent,
  type MemoryWishInvitedEvent,
} from 'src/common/events/domain-events';
import type { AppConfig } from 'src/config/configuration';
import { QUEUE } from 'src/infra/queue/queue.constants';
import { Event, type EventDocument } from 'src/modules/events/schemas/event.schema';
import {
  EventInvite,
  type EventInviteDocument,
} from 'src/modules/events/schemas/event-invite.schema';
import { MediaPurpose } from 'src/modules/media/schemas/media.schema';
import { MediaService } from 'src/modules/media/media.service';
import { UsersService } from 'src/modules/users/users.service';
import { WishmatesService } from 'src/modules/wishmates/wishmates.service';
import { WishmateRelationship, type PublicIdentity } from 'src/modules/wishmates/wishmates.views';
import type { CreateMemoryDto, UpdateMemoryDto } from './dto/memory.dto';
import { MEMORY_UNLOCK_JOB, unlockJobId, type MemoryUnlockJobData } from './memory.jobs';
import {
  MEMORY_MAX_UNLOCK_YEARS,
  MEMORY_SUBMITTABLE,
  MEMORY_TRANSITIONS,
  MemoryStatus,
  type MemoryInviteSkipReason,
} from './memory.types';
import {
  toIncomingMemoryView,
  toMemoryCapsuleView,
  toPublicMemoryView,
  type IncomingMemoryView,
  type MemorySenderView,
  type MemoryCapsuleView,
  type PublicMemoryView,
} from './memory.views';
import { MemoryCapsule, type MemoryCapsuleDocument } from './schemas/memory-capsule.schema';
import { MemoryWish, type MemoryWishDocument } from './schemas/memory-wish.schema';

const generateSlug = customAlphabet('23456789abcdefghijkmnpqrstuvwxyz', 16);

/** A host cannot hold an unbounded number of open capsules. */
const MAX_OPEN_CAPSULES = 50;

@Injectable()
export class MemoriesService {
  private readonly logger = new Logger(MemoriesService.name);
  private readonly web: string;

  constructor(
    @InjectModel(MemoryCapsule.name)
    private readonly capsuleModel: Model<MemoryCapsuleDocument>,
    @InjectModel(MemoryWish.name)
    private readonly wishModel: Model<MemoryWishDocument>,
    @InjectModel(Event.name) private readonly eventModel: Model<EventDocument>,
    @InjectModel(EventInvite.name) private readonly inviteModel: Model<EventInviteDocument>,
    @InjectQueue(QUEUE.SCHEDULER) private readonly scheduler: Queue,
    private readonly media: MediaService,
    private readonly wishmates: WishmatesService,
    private readonly users: UsersService,
    private readonly emitter: EventEmitter2,
    private readonly config: ConfigService<AppConfig, true>,
  ) {
    this.web = this.config.get('app.webAppUrl', { infer: true }).replace(/\/$/, '');
  }

  // ── Create / update ───────────────────────────────────────────────────────

  async create(userId: string, dto: CreateMemoryDto): Promise<MemoryCapsuleView> {
    const unlockAt = MemoriesService.parseUnlock(dto.unlockAt);

    const open = await this.capsuleModel.countDocuments({
      hostId: new Types.ObjectId(userId),
      status: { $ne: MemoryStatus.UNLOCKED },
    });
    if (open >= MAX_OPEN_CAPSULES) {
      throw new AppException(
        ErrorCode.RATE_LIMITED,
        'You already have as many sealed wishes as Wishtick allows',
        429,
      );
    }

    const eventId = dto.eventId
      ? await this.assertEventRecipient(userId, dto.eventId, dto.recipientUserId)
      : null;
    const recipient = await this.assertWishmate(userId, dto.recipientUserId, {
      linkedByEvent: eventId !== null,
    });

    const capsule = await this.capsuleModel.create({
      hostId: new Types.ObjectId(userId),
      title: dto.title,
      recipientUserId: new Types.ObjectId(dto.recipientUserId),
      eventId,
      // Snapshotted, not resolved on read — see the note on the schema field.
      personName: recipient.displayName ?? recipient.username ?? 'A WishMate',
      relation: dto.relation ?? null,
      occasion: dto.occasion,
      occasionDate: dto.occasionDate ? new Date(dto.occasionDate) : null,
      includeYear: dto.includeYear ?? false,
      coverUrl: dto.coverMediaId ? await this.resolveCover(userId, dto.coverMediaId) : null,
      coverMediaId: dto.coverMediaId ? new Types.ObjectId(dto.coverMediaId) : null,
      unlockAt,
      timezone: dto.timezone,
      status: MemoryStatus.COLLECTING,
      share: { slug: generateSlug(), expiresAt: null, rotatedAt: new Date() },
    });

    await this.scheduleUnlock(capsule);
    this.logger.log(`Memory ${capsule._id.toString()} created, unlocks ${unlockAt.toISOString()}`);
    return this.assemble(capsule, userId);
  }

  async update(id: string, userId: string, dto: UpdateMemoryDto): Promise<MemoryCapsuleView> {
    const capsule = await this.findOwnedOrFail(id, userId);
    this.assertMutable(capsule);

    if (dto.title !== undefined) capsule.title = dto.title;
    if (dto.relation !== undefined) capsule.relation = dto.relation;
    if (dto.occasion !== undefined) capsule.occasion = dto.occasion;
    if (dto.occasionDate !== undefined) {
      capsule.occasionDate = dto.occasionDate ? new Date(dto.occasionDate) : null;
    }
    if (dto.includeYear !== undefined) capsule.includeYear = dto.includeYear;
    if (dto.timezone !== undefined) capsule.timezone = dto.timezone;

    if (dto.coverMediaId !== undefined) {
      const previous = capsule.coverMediaId;
      capsule.coverUrl = dto.coverMediaId
        ? await this.resolveCover(userId, dto.coverMediaId)
        : null;
      capsule.coverMediaId = dto.coverMediaId ? new Types.ObjectId(dto.coverMediaId) : null;
      if (previous && previous.toString() !== dto.coverMediaId) {
        await this.media.markOrphaned(previous).catch(() => undefined);
      }
    }

    const moved =
      dto.unlockAt !== undefined && new Date(dto.unlockAt).getTime() !== capsule.unlockAt.getTime();
    if (dto.unlockAt !== undefined) {
      capsule.unlockAt = MemoriesService.parseUnlock(dto.unlockAt);
    }

    await capsule.save();

    // The queued job carries the OLD instant and its staleness guard will make
    // it a no-op, so a moved date needs a fresh one.
    if (moved) {
      await this.scheduleUnlock(capsule);
      this.logger.log(`Memory ${id} moved; unlock rescheduled`);
    }
    return this.assemble(capsule, userId);
  }

  async remove(id: string, userId: string): Promise<void> {
    const capsule = await this.findOwnedOrFail(id, userId);
    // Its creator may delete it at any time, delivered or not — and it goes
    // for everyone, the person it was for included. The app says so before
    // it asks. (Editing is different: an opened memory can no longer change.)
    // Their files go with them. Left READY, they would count against everyone
    // who recorded one for as long as the account lived, and stay billed.
    const wishMedia = await this.wishModel
      .find({ capsuleId: capsule._id, mediaId: { $ne: null } })
      .select('mediaId')
      .exec();
    for (const w of wishMedia) {
      await this.media.markOrphaned(w.mediaId!).catch(() => undefined);
    }
    if (capsule.coverMediaId) {
      await this.media.markOrphaned(capsule.coverMediaId).catch(() => undefined);
    }
    await this.wishModel.deleteMany({ capsuleId: capsule._id }).exec();
    await capsule.deleteOne();
    await this.scheduler.remove(unlockJobId(capsule._id.toString())).catch(() => undefined);
  }

  // ── Read ──────────────────────────────────────────────────────────────────

  /** "Created By You" (`4104:1433`). */
  async listMine(userId: string): Promise<MemoryCapsuleView[]> {
    const capsules = await this.capsuleModel
      .find({ hostId: new Types.ObjectId(userId) })
      .sort({ unlockAt: 1 })
      .limit(MAX_OPEN_CAPSULES)
      .exec();
    return Promise.all(capsules.map((c) => this.assemble(c, userId)));
  }

  /**
   * "Contributed By You" (`4104:1433`) — capsules this user has added a wish to
   * but does not host.
   */
  async listContributed(userId: string): Promise<MemoryCapsuleView[]> {
    const capsuleIds = await this.wishModel
      .distinct('capsuleId', { contributorId: new Types.ObjectId(userId) })
      .exec();
    if (capsuleIds.length === 0) return [];

    const capsules = await this.capsuleModel
      .find({ _id: { $in: capsuleIds }, hostId: { $ne: new Types.ObjectId(userId) } })
      .sort({ unlockAt: 1 })
      .exec();
    return Promise.all(capsules.map((c) => this.assemble(c, userId)));
  }

  /**
   * "For You" — capsules somebody else made *about* the caller.
   *
   * Only once they have opened. A sealed capsule is a surprise, and listing it
   * early would tell the recipient both that it exists and who made it, which
   * is the one thing the time-lock is for.
   */
  async listForMe(userId: string): Promise<MemoryCapsuleView[]> {
    const capsules = await this.capsuleModel
      .find({
        recipientUserId: new Types.ObjectId(userId),
        status: MemoryStatus.UNLOCKED,
      })
      .sort({ unlockAt: -1 })
      .limit(MAX_OPEN_CAPSULES)
      .exec();
    return Promise.all(capsules.map((c) => this.assemble(c, userId)));
  }

  /**
   * Capsules somebody made for the caller that have not opened yet — what the
   * Home countdown is drawn from.
   *
   * [listForMe] stays unlocked-only; this is the narrow exception to it. It
   * tells the recipient a memory is coming and when, which is the whole point
   * of a countdown, and nothing a sealed capsule is keeping from them: no
   * host, no contributors, no title, no content. Soonest first, since the
   * banner counts down to the next one.
   */
  async listIncoming(userId: string): Promise<IncomingMemoryView[]> {
    const capsules = await this.capsuleModel
      .find({
        recipientUserId: new Types.ObjectId(userId),
        status: { $ne: MemoryStatus.UNLOCKED },
      })
      .sort({ unlockAt: 1 })
      .limit(MAX_OPEN_CAPSULES)
      .exec();
    if (capsules.length === 0) return [];

    // Who each is from: the host, then everyone who has added a wish, oldest
    // first — faces and names only, never what they wrote.
    const wishes = await this.wishModel
      .find({ capsuleId: { $in: capsules.map((c) => c._id) } })
      .select('capsuleId contributorId contributorName contributorAvatarUrl createdAt')
      .sort({ createdAt: 1 })
      .lean()
      .exec();
    const accountIds = [
      ...new Set([
        ...capsules.map((c) => c.hostId.toString()),
        ...wishes.flatMap((w) => (w.contributorId ? [w.contributorId.toString()] : [])),
      ]),
    ].filter((id) => id !== userId);
    const people = new Map(
      (await this.identitiesWithFallback(accountIds)).map((p) => [p.userId, p]),
    );
    const person = (id: string): MemorySenderView | null => {
      const p = people.get(id);
      return p
        ? {
            userId: id,
            name: p.displayName ?? 'A WishMate',
            photoUrl: p.photoUrl,
            avatarKey: p.avatarKey,
          }
        : null;
    };

    return capsules.map((capsule) => {
      const seen = new Set<string>();
      const senders: MemorySenderView[] = [];
      const add = (key: string, sender: MemorySenderView | null) => {
        if (!sender || seen.has(key)) return;
        seen.add(key);
        senders.push(sender);
      };
      add(capsule.hostId.toString(), person(capsule.hostId.toString()));
      for (const wish of wishes) {
        if (!wish.capsuleId.equals(capsule._id)) continue;
        const id = wish.contributorId?.toString();
        if (id === userId) continue;
        if (id) {
          add(id, person(id));
        } else {
          add(`name:${wish.contributorName}`, {
            userId: null,
            name: wish.contributorName,
            photoUrl: wish.contributorAvatarUrl ?? null,
            avatarKey: null,
          });
        }
      }
      return toIncomingMemoryView(capsule, senders);
    });
  }

  /**
   * One capsule.
   *
   * Readable by anyone who is signed in: the time-lock lives in the view, not
   * in this check, and a contributor must be able to see the capsule they were
   * invited to. Content is still withheld until it is unlocked.
   */
  async getOne(id: string, userId: string): Promise<MemoryCapsuleView> {
    const capsule = await this.loadOrFail(id);
    return this.assemble(capsule, userId);
  }

  /** What the contribute link resolves to, with no account. */
  async getBySlug(slug: string): Promise<PublicMemoryView> {
    const capsule = await this.capsuleModel.findOne({ 'share.slug': slug }).exec();
    if (!capsule) {
      throw new AppException(ErrorCode.MEMORY_NOT_FOUND, 'Wishes not found', 404);
    }
    const wishes = await this.wishesOf(capsule._id);
    return toPublicMemoryView(capsule, wishes);
  }

  // ── Sharing ───────────────────────────────────────────────────────────────

  /**
   * Shows some of the caller's memories to some of their WishMates.
   *
   * Only memories made *for* the caller, and only opened ones: a sealed
   * capsule's wishes are not readable yet by anybody, and sharing one would
   * only promise the viewer something that is not there. Only WishMates: the
   * wishes were written to the caller, and passing them to an account they
   * have no link with is exactly what the sealed-memory promise rules out.
   *
   * Idempotent — sharing again with somebody who already has it changes
   * nothing, and only people newly given access are told.
   */
  async share(
    userId: string,
    capsuleIds: string[],
    viewerIds: string[],
  ): Promise<{ shared: number; people: number }> {
    const capsules = await this.capsuleModel
      .find({ _id: { $in: [...new Set(capsuleIds)].map((id) => new Types.ObjectId(id)) } })
      .exec();
    // 404 for anything the caller cannot share, rather than sharing the rest:
    // a half-applied share is one the person did not ask for.
    if (capsules.length !== new Set(capsuleIds).size) {
      throw new AppException(ErrorCode.MEMORY_NOT_FOUND, 'Wishes not found', 404);
    }
    for (const capsule of capsules) {
      if (capsule.recipientUserId?.toString() !== userId) {
        throw new AppException(ErrorCode.MEMORY_NOT_FOUND, 'Wishes not found', 404);
      }
      if (capsule.status !== MemoryStatus.UNLOCKED) {
        throw new AppException(
          ErrorCode.INVALID_MEMORY_TRANSITION,
          'Wishes can be shared once they have opened',
          409,
        );
      }
    }

    const viewers = [...new Set(viewerIds)].filter((id) => id !== userId);
    for (const viewerId of viewers) {
      const relationship = await this.wishmates.relationshipWith(userId, viewerId);
      if (relationship !== WishmateRelationship.WISHMATES) {
        throw new AppException(
          ErrorCode.FORBIDDEN,
          'Wishes can only be shared with your WishMates',
          403,
        );
      }
    }
    if (viewers.length === 0) {
      throw new AppException(ErrorCode.VALIDATION_FAILED, 'Choose who to share with', 400);
    }

    // Worked out before the write, so only new access is announced.
    const grants = viewers
      .map((viewerId) => ({
        viewerId,
        capsuleIds: capsules
          .filter((c) => !(c.sharedWith ?? []).some((id) => id.toString() === viewerId))
          .map((c) => c._id.toString()),
      }))
      .filter((g) => g.capsuleIds.length > 0);

    await this.capsuleModel
      .updateMany(
        { _id: { $in: capsules.map((c) => c._id) } },
        { $addToSet: { sharedWith: { $each: viewers.map((id) => new Types.ObjectId(id)) } } },
      )
      .exec();

    if (grants.length > 0) {
      this.emitter.emit(MEMORY_SHARED, {
        ownerId: userId,
        grants,
        titles: Object.fromEntries(capsules.map((c) => [c._id.toString(), c.title])),
        sharedAt: new Date(),
      } satisfies MemorySharedEvent);
    }
    return { shared: capsules.length, people: viewers.length };
  }

  /** Takes one person's access to one memory away. The recipient's own call. */
  async unshare(userId: string, capsuleId: string, viewerId: string): Promise<MemoryCapsuleView> {
    const capsule = await this.loadOrFail(capsuleId);
    if (capsule.recipientUserId?.toString() !== userId) {
      throw new AppException(ErrorCode.MEMORY_NOT_FOUND, 'Wishes not found', 404);
    }
    if (Types.ObjectId.isValid(viewerId)) {
      await this.capsuleModel
        .updateOne({ _id: capsule._id }, { $pull: { sharedWith: new Types.ObjectId(viewerId) } })
        .exec();
    }
    return this.getOne(capsuleId, userId);
  }

  /** "Shared With You" — memories other people have shown the caller. */
  async listSharedWithMe(userId: string): Promise<MemoryCapsuleView[]> {
    const capsules = await this.capsuleModel
      .find({ sharedWith: new Types.ObjectId(userId), status: MemoryStatus.UNLOCKED })
      .sort({ unlockedAt: -1 })
      .limit(MAX_OPEN_CAPSULES)
      .exec();
    return Promise.all(capsules.map((c) => this.assemble(c, userId)));
  }

  // ── Inviting contributors ─────────────────────────────────────────────────

  /**
   * The host asking some of their WishMates, by name, to add a wish.
   *
   * The link has always been the way in, and still is for anyone else; this
   * is the way to reach the people already on Wishtick without leaving it.
   * Nothing here grants access — anyone signed in who holds the capsule id may
   * contribute — so what an invitation actually does is put a notification in
   * front of the right person, once.
   *
   * Ids that cannot be asked are skipped and reported, not refused: a picker of
   * several people that fails wholesale over one stale row is worse than one
   * that asks who it can and says why it left the others out. The recipient is
   * always skipped, before anything else is checked about them — they are the
   * one person whose notification would spoil the whole thing.
   *
   * 404 to anyone but the host, like every host-only call here; 409 once the
   * capsule has stopped taking wishes, since an invitation to add one then
   * would be an invitation to a refusal.
   */
  async invite(
    id: string,
    hostId: string,
    userIds: string[],
  ): Promise<{
    invited: string[];
    skipped: { userId: string; reason: MemoryInviteSkipReason }[];
  }> {
    const capsule = await this.findOwnedOrFail(id, hostId);
    if (!MEMORY_SUBMITTABLE.includes(capsule.status)) {
      throw new AppException(
        ErrorCode.MEMORY_NOT_ACCEPTING_WISHES,
        'No more wishes can be added here',
        409,
      );
    }

    const recipientId = capsule.recipientUserId?.toString() ?? null;
    const asked = new Set((capsule.invitedUserIds ?? []).map((u) => u.toString()));
    // One read for the whole batch rather than a relationship lookup per id.
    const mates = new Set((await this.wishmates.mateIdsOf(hostId)).map((u) => u.toString()));

    // In this order: the recipient is named as the recipient even when they
    // are also a WishMate, which they almost always are.
    const skipReason = (userId: string): MemoryInviteSkipReason | null => {
      if (userId === hostId) return 'self';
      if (userId === recipientId) return 'recipient';
      if (asked.has(userId)) return 'already_invited';
      if (!mates.has(userId)) return 'not_wishmate';
      return null;
    };

    const invited: string[] = [];
    const skipped: { userId: string; reason: MemoryInviteSkipReason }[] = [];
    for (const userId of new Set(userIds)) {
      const reason = skipReason(userId);
      if (reason) skipped.push({ userId, reason });
      else invited.push(userId);
    }

    if (invited.length > 0) {
      // Guarded on the status as well as the id: the capsule may have opened
      // between the read above and now, and an invitation recorded against an
      // opened capsule would announce something nobody can do any more.
      const written = await this.capsuleModel
        .updateOne(
          { _id: capsule._id, status: { $in: MEMORY_SUBMITTABLE } },
          { $addToSet: { invitedUserIds: { $each: invited.map((u) => new Types.ObjectId(u)) } } },
        )
        .exec();
      if (written.matchedCount === 0) {
        throw new AppException(
          ErrorCode.MEMORY_NOT_ACCEPTING_WISHES,
          'No more wishes can be added here',
          409,
        );
      }

      this.emitter.emit(MEMORY_WISH_INVITED, {
        capsuleId: capsule._id.toString(),
        hostId,
        title: capsule.title,
        invitedUserIds: invited,
      } satisfies MemoryWishInvitedEvent);
      this.logger.log(`Memory ${id}: ${invited.length} invited, ${skipped.length} skipped`);
    }
    return { invited, skipped };
  }

  // ── Unlock ────────────────────────────────────────────────────────────────

  /**
   * Opens the capsule now, before its instant. The host's own call — they may
   * decide the party is tonight.
   */
  async unlockNow(id: string, userId: string): Promise<MemoryCapsuleView> {
    const capsule = await this.findOwnedOrFail(id, userId);
    await this.transitionToUnlocked(capsule);
    return this.assemble(capsule, userId);
  }

  /** An admin opening a memory early — the same transition, and the same notices. */
  async unlockAsAdmin(id: string): Promise<void> {
    await this.transitionToUnlocked(await this.loadOrFail(id));
  }

  /**
   * An admin sealing a memory again, to open on [unlockAt] — after it opened
   * by mistake, or to hold it while a report is looked at. Wishes stay sealed:
   * a relocked memory takes no more, because people already saw it.
   */
  async relockAsAdmin(id: string, unlockAt: Date): Promise<void> {
    if (Number.isNaN(unlockAt.getTime()) || unlockAt.getTime() <= Date.now()) {
      throw new AppException(ErrorCode.VALIDATION_FAILED, 'unlockAt must be in the future', 400);
    }
    const capsule = await this.loadOrFail(id);
    capsule.status = MemoryStatus.LOCKED;
    capsule.unlockedAt = null;
    capsule.unlockAt = unlockAt;
    await capsule.save();
    await this.scheduleUnlock(capsule);
  }

  /** The scheduled job's handler. */
  async fireUnlock(data: MemoryUnlockJobData): Promise<{ unlocked: boolean }> {
    const capsule = await this.capsuleModel.findById(data.capsuleId).exec();
    if (!capsule) return { unlocked: false };
    // The host moved the date after this job was queued.
    if (capsule.unlockAt.toISOString() !== data.unlockAtIso) return { unlocked: false };
    if (capsule.status === MemoryStatus.UNLOCKED) return { unlocked: false };

    return { unlocked: await this.tryUnlock(capsule) };
  }

  /**
   * The safety net under the delayed jobs: opens every sealed capsule whose
   * moment has passed. A job lost to a Redis flush or a restart used to leave
   * its capsule sealed for good — the recipient's countdown sitting at zero,
   * and nobody told. Run every minute, so a missed one is at most a minute
   * late; on time, the job has already opened it and this finds nothing.
   */
  async sweepDue(now = new Date(), limit = 100): Promise<number> {
    const due = await this.capsuleModel
      .find({
        status: { $in: [MemoryStatus.COLLECTING, MemoryStatus.LOCKED] },
        unlockAt: { $lte: now },
      })
      .sort({ unlockAt: 1 })
      .limit(limit)
      .exec();
    let opened = 0;
    for (const capsule of due) {
      if (await this.tryUnlock(capsule)) opened++;
    }
    if (opened > 0) this.logger.warn(`Unlock sweep opened ${opened} capsule(s) the queue missed`);
    return opened;
  }

  /** Opens it unless something else got there first. */
  private async tryUnlock(capsule: MemoryCapsuleDocument): Promise<boolean> {
    try {
      await this.transitionToUnlocked(capsule);
      return true;
    } catch (err) {
      if (err instanceof AppException && err.errorCode === ErrorCode.INVALID_MEMORY_TRANSITION) {
        return false;
      }
      throw err;
    }
  }

  private async transitionToUnlocked(capsule: MemoryCapsuleDocument): Promise<void> {
    const alreadyOpen = () =>
      new AppException(ErrorCode.INVALID_MEMORY_TRANSITION, 'These wishes are already open', 409);
    if (!MEMORY_TRANSITIONS[capsule.status].includes(MemoryStatus.UNLOCKED)) throw alreadyOpen();

    // Claimed in one write. The delayed job, the sweep and the host's "open
    // now" can all reach a capsule in the same moment, and only the one that
    // actually flips it may tell everyone — otherwise they hear it twice.
    const unlockedAt = new Date();
    const claimed = await this.capsuleModel
      .updateOne(
        { _id: capsule._id, status: { $ne: MemoryStatus.UNLOCKED } },
        { $set: { status: MemoryStatus.UNLOCKED, unlockedAt } },
      )
      .exec();
    if (claimed.modifiedCount === 0) throw alreadyOpen();
    // The callers read it back.
    capsule.status = MemoryStatus.UNLOCKED;
    capsule.unlockedAt = unlockedAt;

    const contributorIds = (
      await this.wishModel.distinct('contributorId', { capsuleId: capsule._id }).exec()
    )
      .filter((id): id is Types.ObjectId => id !== null)
      .map((id) => id.toString());

    this.emitter.emit(MEMORY_UNLOCKED, {
      capsuleId: capsule._id.toString(),
      hostId: capsule.hostId.toString(),
      contributorIds,
      // The person it was made for. This used to be left out, on the reasoning
      // that a recipient often had no account — which stopped being true when
      // `recipientUserId` became a required WishMate. Leaving them out now
      // means the one person the capsule is FOR is the only one not told it
      // opened, and they cannot reply to something they never heard about.
      recipientId: capsule.recipientUserId?.toString() ?? null,
      title: capsule.title,
      wishCount: capsule.wishCount,
    } satisfies MemoryUnlockedEvent);

    this.logger.log(`Memory ${capsule._id.toString()} unlocked`);
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  async loadOrFail(id: string): Promise<MemoryCapsuleDocument> {
    if (!Types.ObjectId.isValid(id)) {
      throw new AppException(ErrorCode.MEMORY_NOT_FOUND, 'Wishes not found', 404);
    }
    const capsule = await this.capsuleModel.findById(id).exec();
    if (!capsule) {
      throw new AppException(ErrorCode.MEMORY_NOT_FOUND, 'Wishes not found', 404);
    }
    return capsule;
  }

  /** 404, not 403 — a stranger learns nothing about what exists. */
  async findOwnedOrFail(id: string, userId: string): Promise<MemoryCapsuleDocument> {
    const capsule = await this.loadOrFail(id);
    if (capsule.hostId.toString() !== userId) {
      throw new AppException(ErrorCode.MEMORY_NOT_FOUND, 'Wishes not found', 404);
    }
    return capsule;
  }

  private assertMutable(capsule: MemoryCapsuleDocument): void {
    if (capsule.status === MemoryStatus.UNLOCKED) {
      throw new AppException(
        ErrorCode.INVALID_MEMORY_TRANSITION,
        'Wishes that have opened can no longer be edited',
        409,
      );
    }
  }

  private wishesOf(capsuleId: Types.ObjectId): Promise<MemoryWishDocument[]> {
    return this.wishModel.find({ capsuleId }).sort({ order: 1, createdAt: 1 }).exec();
  }

  private async assemble(
    capsule: MemoryCapsuleDocument,
    viewerId: string | null,
  ): Promise<MemoryCapsuleView> {
    const wishes = await this.wishesOf(capsule._id);
    const isRecipient = viewerId !== null && capsule.recipientUserId?.toString() === viewerId;
    const shared = capsule.sharedWith ?? [];
    return toMemoryCapsuleView(capsule, wishes, {
      viewerId,
      shareBaseUrl: this.web,
      person: await this.recipientOf(capsule),
      // Looked up only for the one person allowed to see the list.
      sharedWith:
        isRecipient && shared.length > 0
          ? await this.identitiesWithFallback(shared.map((id) => id.toString()))
          : [],
    });
  }

  /**
   * Everyone in [ids], in order, whether or not they have a profile.
   *
   * [WishmatesService.identitiesOf] answers only for accounts with a profile
   * row, so a WishMate who signed up and filled nothing in would silently
   * drop out of the recipient's "Shared with" list — and could then never be
   * removed from it, because they would not be on it to remove.
   */
  private async identitiesWithFallback(ids: string[]): Promise<PublicIdentity[]> {
    const found = await this.wishmates.identitiesOf(ids);
    const byId = new Map(found.map((p) => [p.userId, p]));
    const missing = ids.filter((id) => !byId.has(id));
    const names =
      missing.length > 0 ? await this.users.displayNamesFor(missing) : new Map<string, string>();
    return ids.map(
      (id) =>
        byId.get(id) ?? {
          userId: id,
          username: null,
          displayName: names.get(id) ?? 'A WishMate',
          photoUrl: null,
          avatarKey: null,
          online: false,
          lastSeenAt: null,
        },
    );
  }

  /**
   * The recipient's identity for the view.
   *
   * Falls back to the name snapshotted on the capsule when the account has no
   * profile row — somebody who signed up and filled nothing in is still a
   * perfectly good recipient, and a null here would leave the card that says
   * who the memory is for blank.
   */
  private async recipientOf(capsule: MemoryCapsuleDocument): Promise<PublicIdentity | null> {
    const id = capsule.recipientUserId;
    if (!id) return null;

    const [identity] = await this.wishmates.identitiesOf([id.toString()]);
    return (
      identity ?? {
        userId: id.toString(),
        username: null,
        displayName: capsule.personName,
        photoUrl: null,
        avatarKey: null,
        online: false,
        lastSeenAt: null,
      }
    );
  }

  /**
   * Refuses a recipient the caller is not linked to.
   *
   * Checked on the server rather than left to the picker: the client only ever
   * offers WishMates, but "the client only offers X" has never been a reason
   * the server may accept Y — and a memory names a real person and collects
   * what other people say about them.
   */
  private async assertWishmate(
    hostId: string,
    recipientUserId: string,
    opts: { linkedByEvent?: boolean } = {},
  ): Promise<PublicIdentity> {
    if (hostId === recipientUserId) {
      throw new AppException(ErrorCode.VALIDATION_FAILED, 'Wishes are made for someone else', 400);
    }

    if (!opts.linkedByEvent) {
      const relationship = await this.wishmates.relationshipWith(hostId, recipientUserId);
      if (relationship !== WishmateRelationship.WISHMATES) {
        throw new AppException(ErrorCode.FORBIDDEN, 'You can only make wishes for a WishMate', 403);
      }
    }

    const [identity] = await this.wishmates.identitiesOf([recipientUserId]);
    if (identity?.displayName) return identity;

    // Linked but with no profile row, or one with no display name — an account
    // that signed up and filled little in. Real enough to receive a memory, and
    // the signup name is a better thing to write on the card than a placeholder.
    const user = await this.users.findById(recipientUserId);
    return {
      userId: recipientUserId,
      username: identity?.username ?? null,
      displayName: user?.name?.trim() || null,
      photoUrl: identity?.photoUrl ?? null,
      avatarKey: identity?.avatarKey ?? null,
      online: identity?.online ?? false,
      lastSeenAt: identity?.lastSeenAt ?? null,
    };
  }

  /**
   * Lets a guest address an event's host or celebrant without being their
   * WishMate.
   *
   * The invitation is the link: the host chose to invite this person, and the
   * celebrant is whoever the host named for the party. Any live invitation
   * counts, whatever the RSVP — someone who cannot make it is the guest most
   * likely to want to send something instead. A revoked invitation does not.
   *
   * 404 for an event the caller is not invited to, so it learns nothing about
   * what exists; 403 for a recipient the event does not name.
   */
  private async assertEventRecipient(
    userId: string,
    eventId: string,
    recipientUserId: string,
  ): Promise<Types.ObjectId> {
    const id = new Types.ObjectId(eventId);
    const invited = await this.inviteModel
      .exists({ eventId: id, invitedUserId: new Types.ObjectId(userId), revokedAt: null })
      .exec();
    const event = invited ? await this.eventModel.findById(id).exec() : null;
    if (!event) {
      throw new AppException(ErrorCode.EVENT_NOT_FOUND, 'Event not found', 404);
    }

    const allowed = [event.hostId, event.forSelf ? null : event.personUserId]
      .filter((u): u is Types.ObjectId => u !== null)
      .map((u) => u.toString());
    if (!allowed.includes(recipientUserId)) {
      throw new AppException(
        ErrorCode.FORBIDDEN,
        "From an invitation you can send wishes to its host or the person it's for",
        403,
      );
    }
    return id;
  }

  private async resolveCover(userId: string, mediaId: string): Promise<string | null> {
    const media = await this.media.getReadyOwned(userId, mediaId);
    if (media.purpose !== MediaPurpose.MEMORY_COVER) {
      throw new AppException(
        ErrorCode.MEDIA_TYPE_NOT_ALLOWED,
        'This media was not uploaded as a cover for wishes',
        400,
      );
    }
    return media.url;
  }

  private async scheduleUnlock(capsule: MemoryCapsuleDocument): Promise<void> {
    const delay = capsule.unlockAt.getTime() - Date.now();
    const jobId = unlockJobId(capsule._id.toString());
    // The old job first. BullMQ ignores an add whose id is already queued, so
    // a moved date used to keep only the old job — which then fired at the old
    // time, saw the date had changed, and opened nothing, ever.
    await this.scheduler.remove(jobId).catch(() => undefined);
    await this.scheduler.add(
      MEMORY_UNLOCK_JOB,
      {
        capsuleId: capsule._id.toString(),
        unlockAtIso: capsule.unlockAt.toISOString(),
      } satisfies MemoryUnlockJobData,
      {
        delay: Math.max(0, delay),
        jobId,
        removeOnComplete: true,
      },
    );
  }

  private static parseUnlock(input: string): Date {
    const date = new Date(input);
    if (Number.isNaN(date.getTime())) {
      throw new AppException(ErrorCode.VALIDATION_FAILED, 'unlockAt is not a date', 400);
    }
    if (date.getTime() <= Date.now()) {
      throw new AppException(
        ErrorCode.VALIDATION_FAILED,
        'unlockAt must be in the future — wishes that are already open are not a surprise',
        400,
      );
    }
    const ceiling = new Date();
    ceiling.setFullYear(ceiling.getFullYear() + MEMORY_MAX_UNLOCK_YEARS);
    if (date.getTime() > ceiling.getTime()) {
      throw new AppException(
        ErrorCode.VALIDATION_FAILED,
        `unlockAt must be within ${MEMORY_MAX_UNLOCK_YEARS} years`,
        400,
      );
    }
    return date;
  }
}
