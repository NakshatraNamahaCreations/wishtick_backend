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
import { MEMORY_UNLOCKED, type MemoryUnlockedEvent } from 'src/common/events/domain-events';
import type { AppConfig } from 'src/config/configuration';
import { QUEUE } from 'src/infra/queue/queue.constants';
import { MediaPurpose } from 'src/modules/media/schemas/media.schema';
import { MediaService } from 'src/modules/media/media.service';
import { UsersService } from 'src/modules/users/users.service';
import { WishmatesService } from 'src/modules/wishmates/wishmates.service';
import { WishmateRelationship, type PublicIdentity } from 'src/modules/wishmates/wishmates.views';
import type { CreateMemoryDto, UpdateMemoryDto } from './dto/memory.dto';
import { MEMORY_UNLOCK_JOB, unlockJobId, type MemoryUnlockJobData } from './memory.jobs';
import { MEMORY_MAX_UNLOCK_YEARS, MEMORY_TRANSITIONS, MemoryStatus } from './memory.types';
import {
  toMemoryCapsuleView,
  toPublicMemoryView,
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
        'You already have as many sealed memories as Wishtick allows',
        429,
      );
    }

    const recipient = await this.assertWishmate(userId, dto.recipientUserId);

    const capsule = await this.capsuleModel.create({
      hostId: new Types.ObjectId(userId),
      title: dto.title,
      recipientUserId: new Types.ObjectId(dto.recipientUserId),
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
      throw new AppException(ErrorCode.MEMORY_NOT_FOUND, 'Memory not found', 404);
    }
    const wishes = await this.wishesOf(capsule._id);
    return toPublicMemoryView(capsule, wishes);
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

  /** The scheduled job's handler. */
  async fireUnlock(data: MemoryUnlockJobData): Promise<{ unlocked: boolean }> {
    const capsule = await this.capsuleModel.findById(data.capsuleId).exec();
    if (!capsule) return { unlocked: false };
    // The host moved the date after this job was queued.
    if (capsule.unlockAt.toISOString() !== data.unlockAtIso) return { unlocked: false };
    if (capsule.status === MemoryStatus.UNLOCKED) return { unlocked: false };

    await this.transitionToUnlocked(capsule);
    return { unlocked: true };
  }

  private async transitionToUnlocked(capsule: MemoryCapsuleDocument): Promise<void> {
    if (!MEMORY_TRANSITIONS[capsule.status].includes(MemoryStatus.UNLOCKED)) {
      throw new AppException(
        ErrorCode.INVALID_MEMORY_TRANSITION,
        'This memory is already open',
        409,
      );
    }
    capsule.status = MemoryStatus.UNLOCKED;
    capsule.unlockedAt = new Date();
    await capsule.save();

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
      throw new AppException(ErrorCode.MEMORY_NOT_FOUND, 'Memory not found', 404);
    }
    const capsule = await this.capsuleModel.findById(id).exec();
    if (!capsule) {
      throw new AppException(ErrorCode.MEMORY_NOT_FOUND, 'Memory not found', 404);
    }
    return capsule;
  }

  /** 404, not 403 — a stranger learns nothing about what exists. */
  async findOwnedOrFail(id: string, userId: string): Promise<MemoryCapsuleDocument> {
    const capsule = await this.loadOrFail(id);
    if (capsule.hostId.toString() !== userId) {
      throw new AppException(ErrorCode.MEMORY_NOT_FOUND, 'Memory not found', 404);
    }
    return capsule;
  }

  private assertMutable(capsule: MemoryCapsuleDocument): void {
    if (capsule.status === MemoryStatus.UNLOCKED) {
      throw new AppException(
        ErrorCode.INVALID_MEMORY_TRANSITION,
        'An opened memory can no longer be edited',
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
    return toMemoryCapsuleView(capsule, wishes, {
      viewerId,
      shareBaseUrl: this.web,
      person: await this.recipientOf(capsule),
    });
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
  private async assertWishmate(hostId: string, recipientUserId: string): Promise<PublicIdentity> {
    if (hostId === recipientUserId) {
      throw new AppException(ErrorCode.VALIDATION_FAILED, 'A memory is made for someone else', 400);
    }

    const relationship = await this.wishmates.relationshipWith(hostId, recipientUserId);
    if (relationship !== WishmateRelationship.WISHMATES) {
      throw new AppException(ErrorCode.FORBIDDEN, 'You can only make a memory for a WishMate', 403);
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

  private async resolveCover(userId: string, mediaId: string): Promise<string | null> {
    const media = await this.media.getReadyOwned(userId, mediaId);
    if (media.purpose !== MediaPurpose.MEMORY_COVER) {
      throw new AppException(
        ErrorCode.MEDIA_TYPE_NOT_ALLOWED,
        'This media was not uploaded as a memory cover',
        400,
      );
    }
    return media.url;
  }

  private async scheduleUnlock(capsule: MemoryCapsuleDocument): Promise<void> {
    const delay = capsule.unlockAt.getTime() - Date.now();
    await this.scheduler.add(
      MEMORY_UNLOCK_JOB,
      {
        capsuleId: capsule._id.toString(),
        unlockAtIso: capsule.unlockAt.toISOString(),
      } satisfies MemoryUnlockJobData,
      {
        delay: Math.max(0, delay),
        jobId: unlockJobId(capsule._id.toString()),
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
        'unlockAt must be in the future — a memory that is already open is not a surprise',
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
