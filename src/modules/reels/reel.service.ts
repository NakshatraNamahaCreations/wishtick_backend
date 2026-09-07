import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { customAlphabet } from 'nanoid';
import { createHash, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Queue } from 'bullmq';
import { Model, Types } from 'mongoose';
import { AppException } from 'src/common/errors/app.exception';
import { ErrorCode } from 'src/common/errors/error-codes';
import type { AppConfig } from 'src/config/configuration';
import { QUEUE } from 'src/infra/queue/queue.constants';
import { STORAGE, type IStorageProvider } from 'src/infra/storage/storage.port';
import { MediaService } from 'src/modules/media/media.service';
import { UsersService } from 'src/modules/users/users.service';
import { FfmpegService } from './ffmpeg.service';
import {
  REEL_COMPILE_JOB,
  REEL_RELEASE_JOB,
  compileJobId,
  releaseJobId,
  type ReelCompileJobData,
  type ReelReleaseJobData,
} from './reel.jobs';
import { nextLocalMidnight } from './reel-schedule';
import { ModerationStatus, ReelStatus, SUBMITTABLE_STATUSES, WishKind } from './reel.types';
import type { CreateReelDto, ShareReelDto, SubmitWishDto } from './dto/reel.dto';
import {
  toPublicReelView,
  toReelView,
  type PublicReelView,
  type ReelCollectionView,
} from './reel.views';
import { ReelCollection, type ReelCollectionDocument } from './schemas/reel-collection.schema';
import { Wish, type WishDocument } from './schemas/wish.schema';

const generateSlug = customAlphabet('23456789abcdefghijkmnpqrstuvwxyz', 16);

@Injectable()
export class ReelService {
  private readonly logger = new Logger(ReelService.name);
  private readonly web: string;

  constructor(
    @InjectModel(ReelCollection.name)
    private readonly collectionModel: Model<ReelCollectionDocument>,
    @InjectModel(Wish.name) private readonly wishModel: Model<WishDocument>,
    @InjectQueue(QUEUE.SCHEDULER) private readonly scheduler: Queue,
    @InjectQueue(QUEUE.REELS) private readonly reelsQueue: Queue,
    @Inject(STORAGE) private readonly storage: IStorageProvider,
    private readonly ffmpeg: FfmpegService,
    private readonly media: MediaService,
    private readonly users: UsersService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {
    this.web = this.config.get('app.webAppUrl', { infer: true }).replace(/\/$/, '');
  }

  // ── Create ────────────────────────────────────────────────────────────────

  async create(userId: string, dto: CreateReelDto): Promise<ReelCollectionView> {
    if (dto.recipientUserId === userId) {
      throw new AppException(
        ErrorCode.CANNOT_RECEIVE_OWN_REEL,
        'You cannot set up your own surprise reel',
        400,
      );
    }
    const recipient = await this.users.findById(dto.recipientUserId);
    if (!recipient) {
      throw new AppException(ErrorCode.NOT_FOUND, 'Recipient not found', 404);
    }

    const birthday = new Date(dto.birthdayDate);
    const month = birthday.getUTCMonth() + 1;
    const day = birthday.getUTCDate();
    const releaseAt = nextLocalMidnight(month, day, dto.timezone);

    const collection = await this.collectionModel.create({
      recipientUserId: new Types.ObjectId(dto.recipientUserId),
      initiatorId: new Types.ObjectId(userId),
      eventId: dto.eventId ? new Types.ObjectId(dto.eventId) : null,
      title: dto.title,
      birthdayMonth: month,
      birthdayDay: day,
      timezone: dto.timezone,
      status: ReelStatus.COLLECTING,
      releaseAt,
      submissionDeadline: releaseAt,
      share: { slug: generateSlug() },
    });

    await this.scheduleRelease(collection);
    this.logger.log(
      `Reel ${collection._id.toString()} created, releases ${releaseAt.toISOString()}`,
    );
    return this.assembleView(collection, userId);
  }

  // ── Submit a wish (with real content validation) ────────────────────────────

  async submitWish(
    collectionId: string,
    userId: string,
    dto: SubmitWishDto,
  ): Promise<{ id: string; kind: string; moderationStatus: string }> {
    const collection = await this.loadOrFail(collectionId);
    if (!SUBMITTABLE_STATUSES.includes(collection.status)) {
      throw new AppException(
        ErrorCode.REEL_NOT_ACCEPTING_WISHES,
        'This reel is closed for wishes',
        409,
      );
    }
    if (collection.submissionDeadline.getTime() <= Date.now()) {
      throw new AppException(
        ErrorCode.REEL_NOT_ACCEPTING_WISHES,
        'The submission window has closed',
        409,
      );
    }
    if (collection.recipientUserId.toString() === userId) {
      throw new AppException(
        ErrorCode.FORBIDDEN,
        'The recipient cannot add to their own reel',
        403,
      );
    }

    const author = await this.users.findById(userId);
    const authorName = dto.authorName ?? author?.name ?? 'A friend';
    const moderationEnabled = this.config.get('reels.moderationEnabled', { infer: true });
    const moderationStatus = moderationEnabled
      ? ModerationStatus.PENDING
      : ModerationStatus.APPROVED;

    let storageKey: string | null = null;
    let contentType: string | null = null;
    let durationMs = 0;

    if (dto.kind === WishKind.TEXT) {
      if (!dto.text) {
        throw new AppException(ErrorCode.WISH_TEXT_REQUIRED, 'A text wish needs text', 400);
      }
    } else {
      if (!dto.mediaId) {
        throw new AppException(
          ErrorCode.WISH_MEDIA_REQUIRED,
          'This wish needs an uploaded media',
          400,
        );
      }
      const mediaDoc = await this.media.getReadyOwned(userId, dto.mediaId);
      const probe = await this.probeMedia(mediaDoc.storageKey);
      // MIME sniffing by actual content, not the declared header: ffprobe read
      // the real streams, so a "video" with no video track is rejected here.
      if (dto.kind === WishKind.VIDEO && !probe.hasVideo) {
        throw new AppException(ErrorCode.WISH_MEDIA_INVALID, 'That file has no video track', 400);
      }
      if (dto.kind === WishKind.AUDIO && !probe.hasAudio) {
        throw new AppException(ErrorCode.WISH_MEDIA_INVALID, 'That file has no audio track', 400);
      }
      const maxMs =
        dto.kind === WishKind.VIDEO
          ? this.config.get('reels.maxVideoDurationMs', { infer: true })
          : this.config.get('reels.maxAudioDurationMs', { infer: true });
      if (probe.durationMs > maxMs + 500) {
        throw new AppException(
          ErrorCode.WISH_DURATION_EXCEEDED,
          `That clip is too long (max ${Math.round(maxMs / 1000)}s)`,
          400,
          { durationMs: probe.durationMs, maxMs },
        );
      }
      storageKey = mediaDoc.storageKey;
      contentType = mediaDoc.contentType;
      durationMs = probe.durationMs;
    }

    // order = current count; a small race just reorders, never conflicts.
    const order = collection.wishCount;
    const [wish] = await this.wishModel.create([
      {
        collectionId: collection._id,
        authorId: new Types.ObjectId(userId),
        authorName,
        kind: dto.kind,
        text: dto.kind === WishKind.TEXT ? dto.text : null,
        mediaId: dto.mediaId ? new Types.ObjectId(dto.mediaId) : null,
        storageKey,
        contentType,
        durationMs,
        moderationStatus,
        order,
      },
    ]);
    await this.collectionModel
      .updateOne({ _id: collection._id }, { $inc: { wishCount: 1 } })
      .exec();

    return { id: wish._id.toString(), kind: wish.kind, moderationStatus: wish.moderationStatus };
  }

  // ── Read (time-locked views) ────────────────────────────────────────────────

  async getForUser(collectionId: string, userId: string): Promise<ReelCollectionView> {
    const collection = await this.loadOrFail(collectionId);
    await this.assertCanView(collection, userId);
    return this.assembleView(collection, userId);
  }

  async listMine(userId: string): Promise<ReelCollectionView[]> {
    const uid = new Types.ObjectId(userId);
    const collections = await this.collectionModel
      .find({ $or: [{ initiatorId: uid }, { recipientUserId: uid }] })
      .sort({ createdAt: -1 })
      .limit(100)
      .exec();
    return Promise.all(collections.map((c) => this.assembleView(c, userId)));
  }

  // ── Moderation + regenerate (initiator) ─────────────────────────────────────

  async moderateWish(
    collectionId: string,
    wishId: string,
    userId: string,
    decision: 'approve' | 'reject',
  ): Promise<{ id: string; moderationStatus: string }> {
    const collection = await this.loadOrFail(collectionId);
    this.assertInitiator(collection, userId);
    if (!Types.ObjectId.isValid(wishId)) {
      throw new AppException(ErrorCode.WISH_NOT_FOUND, 'Wish not found', 404);
    }
    const wish = await this.wishModel.findOne({ _id: wishId, collectionId: collection._id }).exec();
    if (!wish) throw new AppException(ErrorCode.WISH_NOT_FOUND, 'Wish not found', 404);
    wish.moderationStatus =
      decision === 'approve' ? ModerationStatus.APPROVED : ModerationStatus.REJECTED;
    await wish.save();
    return { id: wish._id.toString(), moderationStatus: wish.moderationStatus };
  }

  async regenerate(collectionId: string, userId: string): Promise<ReelCollectionView> {
    const collection = await this.loadOrFail(collectionId);
    this.assertInitiator(collection, userId);
    if (![ReelStatus.RELEASED, ReelStatus.FAILED].includes(collection.status)) {
      throw new AppException(
        ErrorCode.INVALID_REEL_TRANSITION,
        'A reel can only be regenerated after it has released or failed',
        409,
      );
    }
    collection.status = ReelStatus.RELEASING;
    collection.failureReason = null;
    await collection.save();
    await this.enqueueCompile(collection._id.toString());
    return this.assembleView(collection, userId);
  }

  // ── Share + public ──────────────────────────────────────────────────────────

  async configureShare(
    collectionId: string,
    userId: string,
    dto: ShareReelDto,
  ): Promise<ReelCollectionView> {
    const collection = await this.loadOrFail(collectionId);
    this.assertInitiator(collection, userId);
    if (dto.rotate) {
      collection.share.slug = generateSlug();
      collection.share.rotatedAt = new Date();
    }
    if (dto.passcode !== undefined) {
      collection.share.passcodeHash = dto.passcode ? ReelService.hashPasscode(dto.passcode) : null;
    }
    if (dto.expiresAt !== undefined) {
      collection.share.expiresAt = dto.expiresAt ? new Date(dto.expiresAt) : null;
    }
    await collection.save();
    return this.assembleView(collection, userId);
  }

  async getPublicBySlug(slug: string, passcode?: string): Promise<PublicReelView> {
    const collection = await this.resolveShare(slug, passcode);
    // shareCount is a cheap engagement counter — a public open is a "share view".
    await this.collectionModel
      .updateOne({ _id: collection._id }, { $inc: { shareCount: 1 } })
      .exec();
    const wishes = await this.wishesFor(collection);
    return toPublicReelView(collection, wishes);
  }

  async getPublicPreview(slug: string): Promise<{
    title: string;
    description: string;
    image: string | null;
    url: string;
  }> {
    const collection = await this.collectionModel.findOne({ 'share.slug': slug }).exec();
    if (!collection) {
      throw new AppException(ErrorCode.REEL_COLLECTION_NOT_FOUND, 'Reel not found', 404);
    }
    const released = collection.status === ReelStatus.RELEASED;
    return {
      title: collection.title,
      description: released
        ? `A birthday reel with ${collection.wishCount} wishes.`
        : `A birthday reel is being collected — ${collection.wishCount} wishes so far.`,
      image: released ? collection.ogImageUrl : null,
      url: `${this.web}/r/${slug}`,
    };
  }

  // ── Release scheduling (called by the scheduler handler) ────────────────────

  /**
   * Fires at the recipient's local midnight: seal the collection and kick off
   * compilation. Staleness-guarded — if `releaseAt` moved since the job was
   * queued, this is a leftover and no-ops.
   */
  async fireRelease(data: ReelReleaseJobData): Promise<{ released: boolean }> {
    const collection = await this.collectionModel.findById(data.collectionId).exec();
    if (!collection) return { released: false };
    if (collection.releaseAt.toISOString() !== data.releaseAtIso) return { released: false };
    if (![ReelStatus.COLLECTING, ReelStatus.LOCKED].includes(collection.status)) {
      return { released: false };
    }
    collection.status = ReelStatus.RELEASING;
    await collection.save();
    await this.enqueueCompile(collection._id.toString());
    return { released: true };
  }

  private async scheduleRelease(collection: ReelCollectionDocument): Promise<void> {
    const delay = collection.releaseAt.getTime() - Date.now();
    await this.scheduler.add(
      REEL_RELEASE_JOB,
      {
        collectionId: collection._id.toString(),
        releaseAtIso: collection.releaseAt.toISOString(),
      } satisfies ReelReleaseJobData,
      {
        delay: Math.max(0, delay),
        jobId: releaseJobId(collection._id.toString()),
        removeOnComplete: true,
      },
    );
  }

  private async enqueueCompile(collectionId: string): Promise<void> {
    await this.reelsQueue.add(REEL_COMPILE_JOB, { collectionId } satisfies ReelCompileJobData, {
      jobId: compileJobId(collectionId),
      removeOnComplete: true,
    });
  }

  // ── Internals ────────────────────────────────────────────────────────────────

  private async assembleView(
    collection: ReelCollectionDocument,
    userId: string,
  ): Promise<ReelCollectionView> {
    const wishes = await this.wishesFor(collection);
    return toReelView({
      collection,
      wishes,
      canManage: collection.initiatorId.toString() === userId,
      shareBaseUrl: this.web,
    });
  }

  /**
   * The wishes a view is built from. Only APPROVED wishes are ever loaded for a
   * projection — a rejected wish never contributes even a first name — and the
   * view layer withholds their content until the reel is released.
   */
  private async wishesFor(collection: ReelCollectionDocument): Promise<WishDocument[]> {
    return this.wishModel
      .find({ collectionId: collection._id, moderationStatus: ModerationStatus.APPROVED })
      .sort({ order: 1 })
      .exec();
  }

  private async probeMedia(
    storageKey: string,
  ): Promise<{ durationMs: number; hasVideo: boolean; hasAudio: boolean }> {
    const { body } = await this.storage.getObject(storageKey);
    const tmp = path.join(os.tmpdir(), `reel-probe-${randomName()}`);
    try {
      await fs.writeFile(tmp, body);
      const probe = await this.ffmpeg.probe(tmp);
      return { durationMs: probe.durationMs, hasVideo: probe.hasVideo, hasAudio: probe.hasAudio };
    } finally {
      await fs.rm(tmp, { force: true }).catch(() => undefined);
    }
  }

  private async loadOrFail(collectionId: string): Promise<ReelCollectionDocument> {
    if (!Types.ObjectId.isValid(collectionId)) {
      throw new AppException(ErrorCode.REEL_COLLECTION_NOT_FOUND, 'Reel not found', 404);
    }
    const collection = await this.collectionModel.findById(collectionId).exec();
    if (!collection) {
      throw new AppException(ErrorCode.REEL_COLLECTION_NOT_FOUND, 'Reel not found', 404);
    }
    return collection;
  }

  private async assertCanView(collection: ReelCollectionDocument, userId: string): Promise<void> {
    if (
      collection.initiatorId.toString() === userId ||
      collection.recipientUserId.toString() === userId
    ) {
      return;
    }
    const contributed = await this.wishModel.exists({
      collectionId: collection._id,
      authorId: new Types.ObjectId(userId),
    });
    if (!contributed) {
      // 404, not 403 — a reel's existence is not a stranger's to learn.
      throw new AppException(ErrorCode.REEL_COLLECTION_NOT_FOUND, 'Reel not found', 404);
    }
  }

  private assertInitiator(collection: ReelCollectionDocument, userId: string): void {
    if (collection.initiatorId.toString() !== userId) {
      throw new AppException(ErrorCode.FORBIDDEN, 'Only the reel initiator can do this', 403);
    }
  }

  private async resolveShare(slug: string, passcode?: string): Promise<ReelCollectionDocument> {
    const collection = await this.collectionModel.findOne({ 'share.slug': slug }).exec();
    if (!collection) {
      throw new AppException(ErrorCode.SHARE_LINK_INVALID, 'This reel link is invalid', 404);
    }
    if (collection.share.expiresAt && collection.share.expiresAt.getTime() < Date.now()) {
      throw new AppException(ErrorCode.SHARE_LINK_EXPIRED, 'This reel link has expired', 410);
    }
    if (collection.share.passcodeHash) {
      if (!passcode) {
        throw new AppException(
          ErrorCode.SHARE_PASSCODE_REQUIRED,
          'This reel needs a passcode',
          401,
        );
      }
      if (!ReelService.passcodeMatches(passcode, collection.share.passcodeHash)) {
        throw new AppException(ErrorCode.SHARE_PASSCODE_INVALID, 'Incorrect passcode', 403);
      }
    }
    return collection;
  }

  static hashPasscode(passcode: string): string {
    return createHash('sha256').update(passcode).digest('hex');
  }

  private static passcodeMatches(passcode: string, hash: string): boolean {
    const a = Buffer.from(ReelService.hashPasscode(passcode));
    const b = Buffer.from(hash);
    return a.length === b.length && timingSafeEqual(a, b);
  }
}

function randomName(): string {
  return `${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}
