import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
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

    const profile = await this.users.findById(userId);
    const contributorName = dto.contributorName?.trim() || profile?.name?.trim() || 'A friend';

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
    void userId;
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

  /** A contributor may withdraw their own wish while the capsule is still open. */
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
    if (!MEMORY_SUBMITTABLE.includes(capsule.status)) {
      throw new AppException(
        ErrorCode.MEMORY_NOT_ACCEPTING_WISHES,
        'This memory is sealed; its wishes can no longer change',
        409,
      );
    }

    await wish.deleteOne();
    await this.capsuleModel.updateOne({ _id: capsule._id }, { $inc: { wishCount: -1 } }).exec();
  }

  /** "React" on the story viewer (`2078:357`). Only on an open capsule. */
  async react(capsuleId: string, wishId: string): Promise<{ reactionCount: number }> {
    const capsule = await this.capsules.loadOrFail(capsuleId);
    if (!MEMORY_CONTENT_VISIBLE.includes(capsule.status)) {
      throw new AppException(ErrorCode.MEMORY_LOCKED, 'This memory has not opened yet', 409);
    }
    if (!Types.ObjectId.isValid(wishId)) {
      throw new AppException(ErrorCode.MEMORY_WISH_NOT_FOUND, 'Wish not found', 404);
    }
    const wish = await this.wishModel
      .findOneAndUpdate(
        { _id: new Types.ObjectId(wishId), capsuleId: capsule._id },
        { $inc: { reactionCount: 1 } },
        { new: true },
      )
      .exec();
    if (!wish) {
      throw new AppException(ErrorCode.MEMORY_WISH_NOT_FOUND, 'Wish not found', 404);
    }
    return { reactionCount: wish.reactionCount };
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
