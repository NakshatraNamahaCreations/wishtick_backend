import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { MEMORY_WISH_LOVED, type MemoryWishLovedEvent } from 'src/common/events/domain-events';
import { AppException } from 'src/common/errors/app.exception';
import { ErrorCode } from 'src/common/errors/error-codes';
import { MediaPurpose } from 'src/modules/media/schemas/media.schema';
import { MediaService } from 'src/modules/media/media.service';
import { UsersService } from 'src/modules/users/users.service';
import type { AddMemoryWishDto } from './dto/memory.dto';
import {
  MEMORY_CONTENT_VISIBLE,
  MEMORY_KINDS_WITH_MEDIA,
  MEMORY_SUBMITTABLE,
  MemoryWishKind,
} from './memory.types';
import { toMemoryWishView, type MemoryWishView } from './memory.views';
import { MemoriesService } from './memories.service';
import { MemoryCapsule, type MemoryCapsuleDocument } from './schemas/memory-capsule.schema';
import { MemoryWish, type MemoryWishDocument } from './schemas/memory-wish.schema';

/** Nobody needs to sit through a hundred wishes, and the story bar would vanish. */
const MAX_WISHES_PER_CAPSULE = 60;

@Injectable()
export class MemoryWishesService {
  private readonly logger = new Logger(MemoryWishesService.name);

  constructor(
    @InjectModel(MemoryWish.name)
    private readonly wishModel: Model<MemoryWishDocument>,
    @InjectModel(MemoryCapsule.name)
    private readonly capsuleModel: Model<MemoryCapsuleDocument>,
    private readonly capsules: MemoriesService,
    private readonly media: MediaService,
    private readonly users: UsersService,
    private readonly emitter: EventEmitter2,
  ) {}

  /**
   * Adds a wish to a capsule.
   *
   * Anyone signed in who holds the capsule id may contribute — that is what the
   * share link is for. The host may contribute too; they are as entitled to
   * leave a message as anyone they invited.
   */
  async add(capsuleId: string, userId: string, dto: AddMemoryWishDto): Promise<MemoryWishView> {
    const capsule = await this.capsules.loadOrFail(capsuleId);

    if (!MEMORY_SUBMITTABLE.includes(capsule.status)) {
      throw new AppException(
        ErrorCode.MEMORY_NOT_ACCEPTING_WISHES,
        'This memory is closed for wishes',
        409,
      );
    }
    if (capsule.wishCount >= MAX_WISHES_PER_CAPSULE) {
      throw new AppException(
        ErrorCode.MEMORY_NOT_ACCEPTING_WISHES,
        `A memory holds at most ${MAX_WISHES_PER_CAPSULE} wishes`,
        409,
      );
    }

    const text = dto.text?.trim() || null;
    if (dto.kind === MemoryWishKind.TEXT && !text) {
      throw new AppException(
        ErrorCode.MEMORY_WISH_TEXT_REQUIRED,
        'A text wish needs something to say',
        400,
      );
    }

    let mediaUrl: string | null = null;
    let contentType: string | null = null;
    if (MEMORY_KINDS_WITH_MEDIA.includes(dto.kind)) {
      if (!dto.mediaId) {
        throw new AppException(
          ErrorCode.MEMORY_WISH_MEDIA_REQUIRED,
          `A ${dto.kind} wish needs a file`,
          400,
        );
      }
      const media = await this.media.getReadyOwned(userId, dto.mediaId);
      if (media.purpose !== MediaPurpose.MEMORY_WISH) {
        throw new AppException(
          ErrorCode.MEDIA_TYPE_NOT_ALLOWED,
          'This media was not uploaded as a memory wish',
          400,
        );
      }
      MemoryWishesService.assertKindMatchesMedia(dto.kind, media.contentType);
      mediaUrl = media.url;
      contentType = media.contentType;
    }

    // What the contributor typed wins; otherwise their name, resolved from
    // their profile rather than their account — the account name is blank for
    // a phone sign-up, so this card was signed "A friend" by default.
    const contributorName =
      dto.contributorName?.trim() || (await this.users.displayNameFor(userId, 'A friend'));

    const wish = await this.wishModel.create({
      capsuleId: capsule._id,
      contributorId: new Types.ObjectId(userId),
      contributorName,
      kind: dto.kind,
      text,
      mediaId: dto.mediaId ? new Types.ObjectId(dto.mediaId) : null,
      mediaUrl,
      contentType,
      // Appended to the end of the story; ties break by createdAt.
      order: capsule.wishCount,
    });

    // $inc rather than a read-modify-write: two people contributing at once
    // would otherwise both write the same count.
    await this.capsuleModel.updateOne({ _id: capsule._id }, { $inc: { wishCount: 1 } }).exec();

    this.logger.log(`Wish ${wish._id.toString()} added to memory ${capsuleId}`);
    return toMemoryWishView(wish);
  }

  /**
   * The wishes in a capsule.
   *
   * Refuses outright while the capsule is sealed rather than returning an empty
   * list, so a client cannot mistake "locked" for "nobody wrote anything".
   */
  async list(capsuleId: string, userId: string): Promise<MemoryWishView[]> {
    const capsule = await this.capsules.loadOrFail(capsuleId);
    if (!MEMORY_CONTENT_VISIBLE.includes(capsule.status)) {
      throw new AppException(ErrorCode.MEMORY_LOCKED, 'This memory has not opened yet', 409, {
        unlockAt: capsule.unlockAt,
      });
    }
    // Only the person it was written for. `void userId` used to sit here, which
    // made an opened capsule readable by anyone who could name it — the host
    // and every contributor included, so each of them could read what all the
    // others had written. Opening the capsule makes it readable to the
    // recipient; it does not publish it.
    //
    // Not found rather than forbidden: the wishes of a memory somebody is not
    // part of are not theirs to be told about, and a 403 confirms the capsule
    // exists and who it is for.
    if (capsule.recipientUserId?.toString() !== userId) {
      throw new AppException(ErrorCode.MEMORY_NOT_FOUND, 'Memory not found', 404);
    }
    return (
      await this.wishModel.find({ capsuleId: capsule._id }).sort({ order: 1, createdAt: 1 })
    ).map(toMemoryWishView);
  }

  /**
   * The caller's own wishes, readable whether or not the capsule has opened.
   *
   * Deliberately not subject to the time-lock, because it does not weaken it:
   * these are the words the caller wrote themselves, and showing somebody
   * their own message reveals nothing about anyone else's. The lock exists so
   * that a *surprise* stays a surprise — nobody is surprised by their own
   * wish.
   *
   * This is the whole reason the host lost "Open it now". Opening a capsule
   * early to check what was in it broke the promise for everybody at once,
   * and could not be undone; reading back your own contribution answers the
   * same question and costs nothing.
   */
  async listMine(capsuleId: string, userId: string): Promise<MemoryWishView[]> {
    const capsule = await this.capsules.loadOrFail(capsuleId);
    return (
      await this.wishModel
        .find({ capsuleId: capsule._id, contributorId: new Types.ObjectId(userId) })
        .sort({ order: 1, createdAt: 1 })
    ).map(toMemoryWishView);
  }

  /**
   * A contributor may withdraw their own wish at any time — before the
   * memory is sent, or after, when it goes from the recipient's story too.
   * The same as the host, who may delete the whole memory whenever they like.
   */
  async remove(capsuleId: string, wishId: string, userId: string): Promise<void> {
    const capsule = await this.capsules.loadOrFail(capsuleId);
    if (!Types.ObjectId.isValid(wishId)) {
      throw new AppException(ErrorCode.MEMORY_WISH_NOT_FOUND, 'Wish not found', 404);
    }
    const wish = await this.wishModel
      .findOne({ _id: new Types.ObjectId(wishId), capsuleId: capsule._id })
      .exec();
    if (!wish) {
      throw new AppException(ErrorCode.MEMORY_WISH_NOT_FOUND, 'Wish not found', 404);
    }

    // The host may remove anything; a contributor only their own.
    const isHost = capsule.hostId.toString() === userId;
    if (!isHost && wish.contributorId?.toString() !== userId) {
      throw new AppException(ErrorCode.MEMORY_WISH_NOT_FOUND, 'Wish not found', 404);
    }

    await wish.deleteOne();
    // Frees the space it took from the contributor's allowance, and the bytes.
    if (wish.mediaId) await this.media.markOrphaned(wish.mediaId).catch(() => undefined);
    await this.capsuleModel.updateOne({ _id: capsule._id }, { $inc: { wishCount: -1 } }).exec();
  }

  /**
   * "React" on the story viewer (`2078:357`): the person the memory is for
   * loves a wish. Only them, only once it has opened, and only once per wish —
   * pressing it again changes nothing. The first love tells its writer.
   */
  async react(
    capsuleId: string,
    wishId: string,
    userId: string,
  ): Promise<{ reactionCount: number; loved: boolean }> {
    const { capsule, wishOid } = await this.loadForLove(capsuleId, wishId, userId);
    const loved = await this.wishModel
      .findOneAndUpdate(
        { _id: wishOid, capsuleId: capsule._id, lovedAt: null },
        { $set: { lovedAt: new Date(), reactionCount: 1 } },
        { new: true },
      )
      .exec();
    if (loved) {
      if (loved.contributorId && loved.contributorId.toString() !== userId) {
        this.emitter.emit(MEMORY_WISH_LOVED, {
          capsuleId: capsule._id.toString(),
          wishId: loved._id.toString(),
          contributorId: loved.contributorId.toString(),
          lovedByName: capsule.personName,
          capsuleTitle: capsule.title,
        } satisfies MemoryWishLovedEvent);
      }
      return { reactionCount: 1, loved: true };
    }
    // Not changed: already loved, or not one of this memory's wishes.
    const exists = await this.wishModel.exists({ _id: wishOid, capsuleId: capsule._id }).exec();
    if (!exists) {
      throw new AppException(ErrorCode.MEMORY_WISH_NOT_FOUND, 'Wish not found', 404);
    }
    return { reactionCount: 1, loved: true };
  }

  /** Takes a love back. Its writer is not told; nothing was taken from them. */
  async unreact(
    capsuleId: string,
    wishId: string,
    userId: string,
  ): Promise<{ reactionCount: number; loved: boolean }> {
    const { capsule, wishOid } = await this.loadForLove(capsuleId, wishId, userId);
    const res = await this.wishModel
      .updateOne(
        { _id: wishOid, capsuleId: capsule._id },
        { $set: { lovedAt: null, reactionCount: 0 } },
      )
      .exec();
    if (res.matchedCount === 0) {
      throw new AppException(ErrorCode.MEMORY_WISH_NOT_FOUND, 'Wish not found', 404);
    }
    return { reactionCount: 0, loved: false };
  }

  /** The capsule behind a love, after checking it is open and the caller's. */
  private async loadForLove(
    capsuleId: string,
    wishId: string,
    userId: string,
  ): Promise<{ capsule: MemoryCapsuleDocument; wishOid: Types.ObjectId }> {
    const capsule = await this.capsules.loadOrFail(capsuleId);
    if (!MEMORY_CONTENT_VISIBLE.includes(capsule.status)) {
      throw new AppException(ErrorCode.MEMORY_LOCKED, 'This memory has not opened yet', 409);
    }
    if (capsule.recipientUserId?.toString() !== userId) {
      throw new AppException(
        ErrorCode.FORBIDDEN,
        'Only the person this memory is for can react to it',
        403,
      );
    }
    if (!Types.ObjectId.isValid(wishId)) {
      throw new AppException(ErrorCode.MEMORY_WISH_NOT_FOUND, 'Wish not found', 404);
    }
    return { capsule, wishOid: new Types.ObjectId(wishId) };
  }

  /**
   * A photo wish must carry an image and a video wish a video — the media
   * policy allows all three types under one purpose, so the kind is the only
   * thing that says which was meant.
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
        `A ${kind} wish needs ${want} media, not ${contentType ?? 'an unknown type'}`,
        400,
      );
    }
  }
}
