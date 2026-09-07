import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { AppException } from 'src/common/errors/app.exception';
import { ErrorCode } from 'src/common/errors/error-codes';
import { MEMORY_REPLY_SENT, type MemoryReplySentEvent } from 'src/common/events/domain-events';
import { MediaService } from 'src/modules/media/media.service';
import { MediaPurpose } from 'src/modules/media/schemas/media.schema';
import { UsersService } from 'src/modules/users/users.service';
import { WishmatesService } from 'src/modules/wishmates/wishmates.service';
import type { PublicIdentity } from 'src/modules/wishmates/wishmates.views';
import type { SendMemoryReplyDto } from './dto/memory.dto';
import { MEMORY_KINDS_WITH_MEDIA, MemoryStatus, MemoryWishKind } from './memory.types';
import { toMemoryReplyView, type MemoryReplyView, type ReplyAudienceEntry } from './memory.views';
import { MemoriesService } from './memories.service';
import { MemoryCapsule, type MemoryCapsuleDocument } from './schemas/memory-capsule.schema';
import { MemoryReply, type MemoryReplyDocument } from './schemas/memory-reply.schema';
import { MemoryWish, type MemoryWishDocument } from './schemas/memory-wish.schema';

/** One person the caller may reply to, before it is turned into a view. */
interface AudienceMember {
  userId: string;
  isHost: boolean;
  capsuleId: Types.ObjectId;
  capsuleTitle: string;
}

/**
 * Replies: what the person a memory was made for sends back to the people who
 * filled it.
 *
 * The direction is the whole reason this is not [MemoryWishesService]. A wish
 * goes *into* a sealed capsule and waits; a reply goes *out* to named people
 * and arrives at once. They share a composer and a set of kinds, and nothing
 * else — the permission question, the time-lock question and the delivery
 * question all have opposite answers.
 */
@Injectable()
export class MemoryRepliesService {
  private readonly logger = new Logger(MemoryRepliesService.name);

  constructor(
    @InjectModel(MemoryReply.name)
    private readonly replyModel: Model<MemoryReplyDocument>,
    @InjectModel(MemoryWish.name)
    private readonly wishModel: Model<MemoryWishDocument>,
    @InjectModel(MemoryCapsule.name)
    private readonly capsuleModel: Model<MemoryCapsuleDocument>,
    private readonly capsules: MemoriesService,
    private readonly media: MediaService,
    private readonly users: UsersService,
    private readonly wishmates: WishmatesService,
    private readonly emitter: EventEmitter2,
  ) {}

  /**
   * Everyone who has sent the caller a memory, across every capsule of theirs
   * that has opened.
   *
   * This is the *only* source of a legal addressee. Building it from real
   * contributions rather than trusting a client-supplied list is what stops a
   * reply being repurposed into a way to message an arbitrary account.
   *
   * Sealed capsules are excluded along with everything in them: a capsule that
   * has not opened is still a surprise, and naming its contributors would give
   * away both that it exists and who is behind it.
   */
  async audience(userId: string): Promise<ReplyAudienceEntry[]> {
    const members = await this.audienceMembers(userId);
    if (members.length === 0) return [];

    const byId = await this.identify([...new Set(members.map((m) => m.userId))]);

    return members.map((m) => ({
      person: byId.get(m.userId)!,
      isHost: m.isHost,
      capsuleId: m.capsuleId.toString(),
      capsuleTitle: m.capsuleTitle,
    }));
  }

  /**
   * Names and avatars for a set of users, with nobody dropped.
   *
   * `identitiesOf` reads WishMate profiles, and a profile row only exists once
   * somebody has been through onboarding — so on its own it silently omits
   * anyone who has not. That is tolerable for a chat list, which can render an
   * unnamed thread, and not tolerable here: an omission would quietly make
   * somebody who sent you a memory impossible to reply to. The account row is
   * the fallback, which always exists and always has a name.
   */
  private async identify(userIds: string[]): Promise<Map<string, PublicIdentity>> {
    const byId = new Map<string, PublicIdentity>();
    for (const identity of await this.wishmates.identitiesOf(userIds)) {
      byId.set(identity.userId, identity);
    }

    const missing = userIds.filter((id) => !byId.has(id));
    if (missing.length === 0) return byId;

    for (const account of await this.users.findManyByIds(missing)) {
      const id = account._id.toString();
      byId.set(id, {
        userId: id,
        username: null,
        displayName: account.name?.trim() || 'A friend',
        photoUrl: null,
        avatarKey: null,
        online: false,
        lastSeenAt: null,
      });
    }

    // A soft-deleted account has neither row. Naming them at all would be a
    // fiction, so they simply cannot be replied to.
    for (const id of userIds) {
      if (!byId.has(id)) {
        byId.set(id, {
          userId: id,
          username: null,
          displayName: 'A friend',
          photoUrl: null,
          avatarKey: null,
          online: false,
          lastSeenAt: null,
        });
      }
    }
    return byId;
  }

  /**
   * Sends one reply to everyone named.
   *
   * The recipient list is intersected with the real audience rather than
   * validated one id at a time: an id that does not belong is dropped, and only
   * a list with nothing left in it is an error. A client working from a
   * slightly stale audience should not have its whole send refused because one
   * person's capsule was deleted a moment ago.
   */
  async send(userId: string, dto: SendMemoryReplyDto): Promise<MemoryReplyView> {
    const members = await this.audienceMembers(userId);
    const allowed = new Map<string, AudienceMember>();
    for (const m of members) {
      // First capsule wins — it only decides which memory the notification
      // deep-links to, and any capsule this person sent is a fair answer.
      if (!allowed.has(m.userId)) allowed.set(m.userId, m);
    }

    const wanted = [...new Set(dto.recipientIds)].filter((id) => allowed.has(id));
    if (wanted.length === 0) {
      throw new AppException(
        ErrorCode.MEMORY_REPLY_NO_AUDIENCE,
        'None of those people have sent you a memory',
        403,
      );
    }

    const text = dto.text?.trim() || null;
    if (dto.kind === MemoryWishKind.TEXT && !text) {
      throw new AppException(
        ErrorCode.MEMORY_WISH_TEXT_REQUIRED,
        'A text reply needs something to say',
        400,
      );
    }

    let mediaUrl: string | null = null;
    let contentType: string | null = null;
    let durationMs = 0;
    if (MEMORY_KINDS_WITH_MEDIA.includes(dto.kind)) {
      if (!dto.mediaId) {
        throw new AppException(
          ErrorCode.MEMORY_WISH_MEDIA_REQUIRED,
          `A ${dto.kind} reply needs a file`,
          400,
        );
      }
      const media = await this.media.getReadyOwned(userId, dto.mediaId);
      if (media.purpose !== MediaPurpose.MEMORY_REPLY) {
        throw new AppException(
          ErrorCode.MEDIA_TYPE_NOT_ALLOWED,
          'This media was not uploaded as a memory reply',
          400,
        );
      }
      MemoryRepliesService.assertKindMatchesMedia(dto.kind, media.contentType);
      mediaUrl = media.url;
      contentType = media.contentType;
      durationMs = (media.durationSeconds ?? 0) * 1000;
    }

    // The avatar lives on the WishMate profile rather than the user row, so the
    // same resolver the audience uses answers for the author too.
    const me = (await this.identify([userId])).get(userId);
    const chosen = wanted.map((id) => allowed.get(id)!);

    const reply = await this.replyModel.create({
      authorId: new Types.ObjectId(userId),
      authorName: me?.displayName?.trim() || me?.username?.trim() || 'A friend',
      authorAvatarUrl: me?.photoUrl ?? null,
      recipientIds: wanted.map((id) => new Types.ObjectId(id)),
      capsuleIds: [...new Set(chosen.map((m) => m.capsuleId.toString()))].map(
        (id) => new Types.ObjectId(id),
      ),
      kind: dto.kind,
      text,
      mediaId: dto.mediaId ? new Types.ObjectId(dto.mediaId) : null,
      mediaUrl,
      contentType,
      durationMs,
    });

    this.emitter.emit(MEMORY_REPLY_SENT, {
      replyId: reply._id.toString(),
      authorId: userId,
      authorName: reply.authorName,
      recipientIds: wanted,
      capsuleId: chosen[0].capsuleId.toString(),
      capsuleTitle: chosen[0].capsuleTitle,
    } satisfies MemoryReplySentEvent);

    this.logger.log(`Reply ${reply._id.toString()} sent to ${wanted.length} people`);
    return toMemoryReplyView(reply, userId);
  }

  /**
   * The replies shown on one capsule's screen.
   *
   * A viewer sees a reply here only if they were addressed by it AND they had a
   * part in this capsule — or if they wrote it. That second condition is what
   * keeps a reply addressed across several memories from telling one host that
   * the others exist.
   */
  async listForCapsule(capsuleId: string, userId: string): Promise<MemoryReplyView[]> {
    const capsule = await this.capsules.loadOrFail(capsuleId);
    const viewer = new Types.ObjectId(userId);

    const isSender =
      capsule.hostId.toString() === userId ||
      (await this.wishModel.exists({ capsuleId: capsule._id, contributorId: viewer })) !== null;
    const isAuthor = capsule.recipientUserId?.toString() === userId;
    if (!isSender && !isAuthor) return [];

    const replies = await this.replyModel
      .find({
        capsuleIds: capsule._id,
        ...(isAuthor && !isSender ? { authorId: viewer } : { recipientIds: viewer }),
      })
      .sort({ createdAt: -1 })
      .exec();

    return replies.map((r) => toMemoryReplyView(r, userId));
  }

  /** The author withdrawing their own reply. It vanishes for everyone at once. */
  async remove(replyId: string, userId: string): Promise<void> {
    if (!Types.ObjectId.isValid(replyId)) {
      throw new AppException(ErrorCode.MEMORY_REPLY_NOT_FOUND, 'Reply not found', 404);
    }
    const reply = await this.replyModel
      .findOne({ _id: new Types.ObjectId(replyId), authorId: new Types.ObjectId(userId) })
      .exec();
    if (!reply) {
      throw new AppException(ErrorCode.MEMORY_REPLY_NOT_FOUND, 'Reply not found', 404);
    }
    await reply.deleteOne();
  }

  /**
   * Everyone who sent the caller something, as raw rows — one per person per
   * capsule, so the same person appearing in two memories yields two.
   */
  private async audienceMembers(userId: string): Promise<AudienceMember[]> {
    const capsules = await this.capsuleModel
      .find({
        recipientUserId: new Types.ObjectId(userId),
        status: MemoryStatus.UNLOCKED,
      })
      .sort({ unlockAt: -1 })
      .exec();
    if (capsules.length === 0) return [];

    const wishes = await this.wishModel
      .find({ capsuleId: { $in: capsules.map((c) => c._id) }, contributorId: { $ne: null } })
      .select('capsuleId contributorId')
      .exec();

    const contributorsByCapsule = new Map<string, Set<string>>();
    for (const wish of wishes) {
      const key = wish.capsuleId.toString();
      const set = contributorsByCapsule.get(key) ?? new Set<string>();
      set.add(wish.contributorId!.toString());
      contributorsByCapsule.set(key, set);
    }

    const members: AudienceMember[] = [];
    for (const capsule of capsules) {
      const ids = new Set<string>([
        capsule.hostId.toString(),
        ...(contributorsByCapsule.get(capsule._id.toString()) ?? []),
      ]);
      // Replying to yourself is not a thing, and a host may well have written
      // a wish into their own capsule.
      ids.delete(userId);
      for (const id of ids) {
        members.push({
          userId: id,
          isHost: id === capsule.hostId.toString(),
          capsuleId: capsule._id,
          capsuleTitle: capsule.title,
        });
      }
    }
    return members;
  }

  /**
   * A photo reply must carry an image and a video reply a video — the media
   * policy allows all three under one purpose, so the kind is the only thing
   * that says which was meant.
   */
  private static assertKindMatchesMedia(kind: MemoryWishKind, contentType: string | null): void {
    const family = contentType?.split('/')[0];
    const expected: Partial<Record<MemoryWishKind, string>> = {
      [MemoryWishKind.PHOTO]: 'image',
      [MemoryWishKind.VIDEO]: 'video',
      [MemoryWishKind.AUDIO]: 'audio',
    };
    const want = expected[kind];
    if (want && family !== want) {
      throw new AppException(
        ErrorCode.MEDIA_TYPE_NOT_ALLOWED,
        `A ${kind} reply needs ${want} media, not ${contentType ?? 'an unknown type'}`,
        400,
      );
    }
  }
}
