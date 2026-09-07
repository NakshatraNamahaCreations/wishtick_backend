import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { randomUUID } from 'node:crypto';
import { Model, Types } from 'mongoose';
import { AppException } from 'src/common/errors/app.exception';
import { ErrorCode } from 'src/common/errors/error-codes';
import type { AppConfig } from 'src/config/configuration';
import { STORAGE, type IStorageProvider } from 'src/infra/storage/storage.port';
import { VIDEO, VideoState, type IVideoProvider } from 'src/infra/video/video.port';
import { MEDIA_RULES } from './media.policy';
import { Media, MediaPurpose, MediaStatus, type MediaDocument } from './schemas/media.schema';

export interface UploadTicket {
  mediaId: string;
  uploadUrl: string;
  storageKey: string;
  requiredHeaders: Record<string, string>;
  expiresAt: Date;
  maxBytes: number;
}

export interface MediaView {
  id: string;
  url: string;
  purpose: MediaPurpose;
  contentType: string | null;
  sizeBytes: number | null;
  status: MediaStatus;
  /** Seconds, once a transcoder has measured it. Null for stills. */
  durationSeconds?: number | null;
}

/** What a client may upload for one purpose. See [MediaService.limits]. */
export interface PurposeLimit {
  maxBytes: number;
  /** Null where a purpose has no duration ceiling, or nothing to measure. */
  maxDurationSeconds: number | null;
  mimeTypes: string[];
}

export type MediaLimitsView = Record<MediaPurpose, PurposeLimit>;

@Injectable()
export class MediaService {
  private readonly logger = new Logger(MediaService.name);

  constructor(
    @InjectModel(Media.name) private readonly model: Model<MediaDocument>,
    @Inject(STORAGE) private readonly storage: IStorageProvider,
    @Inject(VIDEO) private readonly video: IVideoProvider,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  /**
   * The effective cap and allowlist for every purpose, so a client can refuse an
   * oversized file at the picker instead of after the bytes have gone up.
   *
   * It has to be served rather than hardcoded in the app because the number is
   * not written down in any one place: it is `min(per-purpose rule, the global
   * MEDIA_MAX_BYTES)`, and the second half is environment configuration. A
   * client guessing from [MEDIA_RULES] alone would read 50 MB for a memory wish
   * and promise the user something this deployment refuses at 10.
   */
  limits(): MediaLimitsView {
    const globalMax = this.config.get('storage.maxBytes', { infer: true });
    const entries = Object.entries(MEDIA_RULES).map(([purpose, rule]) => [
      purpose,
      {
        maxBytes: Math.min(rule.maxBytes, globalMax),
        maxDurationSeconds: rule.maxDurationSeconds ?? null,
        mimeTypes: rule.mimeTypes,
      },
    ]);
    return Object.fromEntries(entries) as MediaLimitsView;
  }

  /** Whether this upload should be handed to the transcoder rather than served flat. */
  private handledByTranscoder(contentType: string | null): boolean {
    return this.video.enabled && (contentType ?? '').startsWith('video/');
  }

  /**
   * The URL stored for a transcoded clip.
   *
   * Stable and ours, not the vendor's: playback URLs are signed and expire, and
   * `url` is snapshotted into wishlists, memories, events and thank-you notes
   * when media is attached. A signed URL saved there would rot in every one of
   * them a few hours later. This one redirects to a freshly signed URL on each
   * play, so the link a memory holds is good forever.
   */
  private playUrl(mediaId: string): string {
    const base = this.config.get('app.appUrl', { infer: true }).replace(/\/$/, '');
    const prefix = this.config.get('app.apiPrefix', { infer: true });
    return `${base}/${prefix}/v1/media/${mediaId}/play`;
  }

  /**
   * Issues a presigned upload. The Media doc is created PENDING: at this point
   * we have only a promise that bytes will arrive, and plenty never will.
   */
  async createUploadUrl(
    ownerId: string,
    input: { purpose: MediaPurpose; contentType: string; sizeBytes?: number },
  ): Promise<UploadTicket> {
    const rule = MEDIA_RULES[input.purpose];

    if (!rule.mimeTypes.includes(input.contentType)) {
      throw new AppException(
        ErrorCode.MEDIA_TYPE_NOT_ALLOWED,
        `${input.contentType} is not allowed for ${input.purpose}`,
        400,
        { allowed: rule.mimeTypes },
      );
    }

    // Reject an oversized upload before issuing the URL. This is a courtesy
    // check on a client-supplied number, not a control — confirm() re-checks
    // against what storage actually holds.
    const maxBytes = Math.min(rule.maxBytes, this.config.get('storage.maxBytes', { infer: true }));
    if (input.sizeBytes && input.sizeBytes > maxBytes) {
      throw new AppException(
        ErrorCode.MEDIA_TOO_LARGE,
        `File exceeds the ${Math.floor(maxBytes / (1024 * 1024))}MB limit for ${input.purpose}`,
        413,
        { maxBytes },
      );
    }

    const storageKey = MediaService.buildKey(ownerId, input.purpose, input.contentType);
    const ttlSeconds = this.config.get('storage.urlTtlSeconds', { infer: true });

    const presigned = await this.storage.createUploadUrl({
      storageKey,
      contentType: input.contentType,
      maxBytes,
      ttlSeconds,
    });

    const media = await this.model.create({
      ownerId: new Types.ObjectId(ownerId),
      purpose: input.purpose,
      storageKey,
      status: MediaStatus.PENDING,
      declaredContentType: input.contentType,
      declaredSizeBytes: input.sizeBytes ?? null,
    });

    return {
      mediaId: media._id.toString(),
      uploadUrl: presigned.uploadUrl,
      storageKey,
      requiredHeaders: presigned.requiredHeaders,
      expiresAt: presigned.expiresAt,
      maxBytes,
    };
  }

  /**
   * Verifies the bytes landed and records what was *actually* stored.
   *
   * Everything the client said at upload-url time was a claim. A presigned URL
   * grants a real write to real storage, so this HEAD is the only point where
   * the true size and type are known — a client that asked for a 2 MB JPEG can
   * still PUT a 50 MB file. Idempotent: confirming twice is not an error,
   * because a client retrying on a dropped response is normal.
   */
  async confirm(ownerId: string, mediaId: string): Promise<MediaView> {
    const media = await this.model.findById(mediaId).exec();

    // Same 404 whether the media does not exist or belongs to someone else —
    // distinguishing them would let anyone probe for valid media ids.
    if (!media || media.ownerId.toString() !== ownerId) {
      throw new AppException(ErrorCode.MEDIA_NOT_FOUND, 'Media not found', 404);
    }

    if (media.status === MediaStatus.READY) return MediaService.toView(media);

    const info = await this.storage.head(media.storageKey);
    if (!info.exists) {
      throw new AppException(
        ErrorCode.MEDIA_NOT_UPLOADED,
        'No file has been uploaded for this media yet',
        409,
      );
    }

    const rule = MEDIA_RULES[media.purpose];
    const maxBytes = Math.min(rule.maxBytes, this.config.get('storage.maxBytes', { infer: true }));

    // Enforce against the real object, and delete on violation — leaving a
    // rejected file in the bucket means paying to store what we refused.
    if (info.sizeBytes !== undefined && info.sizeBytes > maxBytes) {
      await this.discard(media, 'oversize');
      throw new AppException(
        ErrorCode.MEDIA_TOO_LARGE,
        `Uploaded file exceeds the ${Math.floor(maxBytes / (1024 * 1024))}MB limit`,
        413,
        { maxBytes, actualBytes: info.sizeBytes },
      );
    }

    const actualType = info.contentType ?? media.declaredContentType;
    if (!rule.mimeTypes.includes(actualType)) {
      await this.discard(media, 'disallowed-type');
      throw new AppException(
        ErrorCode.MEDIA_TYPE_NOT_ALLOWED,
        `${actualType} is not allowed for ${media.purpose}`,
        400,
        { allowed: rule.mimeTypes },
      );
    }

    media.contentType = actualType;
    media.sizeBytes = info.sizeBytes ?? null;
    media.confirmedAt = new Date();

    if (this.handledByTranscoder(actualType)) {
      // Hand the clip to the transcoder by URL. It is already in storage, and
      // the vendor pulls it from there — so the phone still uploaded exactly
      // once, with the plain PUT it can already do.
      const { videoId } = await this.video.ingest({
        title: media._id.toString(),
        sourceUrl: this.storage.getPublicUrl(media.storageKey),
      });
      media.videoId = videoId;
      media.status = MediaStatus.PROCESSING;
      media.url = this.playUrl(media._id.toString());
      await media.save();
      this.logger.log(`Media ${media._id.toString()} handed to transcoder as ${videoId}`);
      return MediaService.toView(media);
    }

    media.status = MediaStatus.READY;
    media.url = this.storage.getPublicUrl(media.storageKey);
    await media.save();

    return MediaService.toView(media);
  }

  /**
   * Brings a transcoding clip's status up to date, and promotes it when the
   * encode has finished.
   *
   * Pulled rather than pushed: a webhook needs a public callback URL, which a
   * dev machine does not have, and polling on read costs one call on exactly
   * the screens that are waiting for the answer anyway.
   */
  async syncVideo(media: MediaDocument): Promise<MediaDocument> {
    if (media.status !== MediaStatus.PROCESSING || !media.videoId) return media;
    if (!this.video.enabled) return media;

    let info;
    try {
      info = await this.video.info(media.videoId);
    } catch (err) {
      // A transcoder that is down must not turn into a failed upload — the
      // clip is still encoding, we just cannot see it this second.
      this.logger.warn(
        `Could not read video ${media.videoId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return media;
    }

    if (info.state === VideoState.READY) {
      // The first point the real duration is known. The client checks it at the
      // picker, which is where a person should be told — but that is a courtesy
      // to an honest client, not a control, so it is re-checked here against
      // what the transcoder actually measured.
      //
      // Late, unavoidably: the clip has already been uploaded and encoded, and
      // may already be attached to a wish. Refusing it here turns that wish's
      // video into a failed one, which is the right outcome for a client that
      // sent a clip it was told not to.
      const maxDuration = MEDIA_RULES[media.purpose].maxDurationSeconds;
      if (maxDuration && info.durationSeconds && info.durationSeconds > maxDuration) {
        media.status = MediaStatus.FAILED;
        await media.save();
        await this.video.delete(media.videoId).catch(() => undefined);
        await this.storage.delete(media.storageKey).catch(() => undefined);
        this.logger.warn(
          `Media ${media._id.toString()} rejected: ${info.durationSeconds}s exceeds the ` +
            `${maxDuration}s limit for ${media.purpose}`,
        );
        return media;
      }

      media.status = MediaStatus.READY;
      media.durationSeconds = info.durationSeconds;
      media.thumbnailFileName = info.thumbnailFileName;
      await media.save();
      // The source file has served its purpose — the ladder is the playable
      // copy now, and keeping the original doubles the bill for every clip.
      await this.storage.delete(media.storageKey).catch(() => undefined);
      this.logger.log(`Media ${media._id.toString()} finished encoding`);
    } else if (info.state === VideoState.FAILED) {
      media.status = MediaStatus.FAILED;
      await media.save();
      this.logger.error(`Media ${media._id.toString()} failed to encode`);
    }

    return media;
  }

  /** Fetches media the caller owns and has confirmed. Used before attaching it. */
  async getReadyOwned(ownerId: string, mediaId: string): Promise<MediaDocument> {
    if (!Types.ObjectId.isValid(mediaId)) {
      throw new AppException(ErrorCode.MEDIA_NOT_FOUND, 'Media not found', 404);
    }
    const media = await this.model.findById(mediaId).exec();
    if (!media || media.ownerId.toString() !== ownerId) {
      throw new AppException(ErrorCode.MEDIA_NOT_FOUND, 'Media not found', 404);
    }
    // PROCESSING counts as attachable. The bytes are in, the URL is stable and
    // will resolve the moment the encode lands — blocking here would make the
    // host sit on the compose screen watching a spinner for a transcode that
    // has nothing to do with them.
    if (media.status !== MediaStatus.READY && media.status !== MediaStatus.PROCESSING) {
      throw new AppException(
        ErrorCode.MEDIA_NOT_UPLOADED,
        'This media has not been uploaded and confirmed yet',
        409,
      );
    }
    return media;
  }

  /** One media the caller owns, with any in-flight transcode brought up to date. */
  async viewOwned(ownerId: string, mediaId: string): Promise<MediaView> {
    if (!Types.ObjectId.isValid(mediaId)) {
      throw new AppException(ErrorCode.MEDIA_NOT_FOUND, 'Media not found', 404);
    }
    const media = await this.model.findById(mediaId).exec();
    if (!media || media.ownerId.toString() !== ownerId) {
      throw new AppException(ErrorCode.MEDIA_NOT_FOUND, 'Media not found', 404);
    }
    return MediaService.toView(await this.syncVideo(media));
  }

  /**
   * A freshly signed URL for whatever this media actually is.
   *
   * Transcoded clips get a short-lived signed playlist; anything else redirects
   * to its ordinary public URL, so the same stable link works either way and
   * callers never branch on media type.
   */
  async playbackUrl(mediaId: string): Promise<string> {
    if (!Types.ObjectId.isValid(mediaId)) {
      throw new AppException(ErrorCode.MEDIA_NOT_FOUND, 'Media not found', 404);
    }
    const found = await this.model.findById(mediaId).exec();
    if (!found) throw new AppException(ErrorCode.MEDIA_NOT_FOUND, 'Media not found', 404);

    const media = await this.syncVideo(found);

    if (media.videoId && this.video.enabled) {
      if (media.status === MediaStatus.FAILED) {
        throw new AppException(ErrorCode.MEDIA_NOT_FOUND, 'This video could not be processed', 404);
      }
      if (media.status !== MediaStatus.READY) {
        throw new AppException(
          ErrorCode.MEDIA_NOT_UPLOADED,
          'This video is still being processed',
          409,
        );
      }
      return this.video.playbackUrl(media.videoId);
    }

    return this.storage.getPublicUrl(media.storageKey);
  }

  async findById(mediaId: string): Promise<MediaDocument | null> {
    if (!Types.ObjectId.isValid(mediaId)) return null;
    return this.model.findById(mediaId).exec();
  }

  /** Marks media orphaned so the sweeper can reclaim the object. */
  async markOrphaned(mediaId: Types.ObjectId): Promise<void> {
    await this.model.updateOne({ _id: mediaId }, { $set: { status: MediaStatus.ORPHANED } }).exec();
  }

  async deleteAllForOwner(ownerId: Types.ObjectId): Promise<number> {
    const owned = await this.model.find({ ownerId }).exec();
    let deleted = 0;
    for (const media of owned) {
      try {
        // A transcoded clip lives at the vendor, not in the bucket — erasing
        // the object alone would leave the watchable copy behind.
        if (media.videoId && this.video.enabled) {
          await this.video.delete(media.videoId).catch(() => undefined);
        }
        await this.storage.delete(media.storageKey);
        deleted++;
      } catch (err) {
        // Keep going: one unreachable object must not abort the erasure of the
        // rest. The doc is removed regardless, and the object is logged.
        this.logger.error(
          `Failed to delete ${media.storageKey}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    await this.model.deleteMany({ ownerId }).exec();
    return deleted;
  }

  private async discard(media: MediaDocument, reason: string): Promise<void> {
    this.logger.warn(`Discarding media ${media._id.toString()} (${reason})`);
    if (media.videoId && this.video.enabled) {
      await this.video.delete(media.videoId).catch(() => undefined);
    }
    await this.storage.delete(media.storageKey).catch(() => undefined);
    await this.model.deleteOne({ _id: media._id }).exec();
  }

  /**
   * Keys are namespaced by owner and randomized. Random rather than
   * user-supplied: a filename from a client is attacker-controlled, and the
   * name is also PII we would otherwise store forever.
   */
  private static buildKey(ownerId: string, purpose: MediaPurpose, contentType: string): string {
    const ext = MEDIA_RULES[purpose].extensions[contentType] ?? 'bin';
    return `users/${ownerId}/${purpose}/${randomUUID()}.${ext}`;
  }

  static toView(media: MediaDocument): MediaView {
    return {
      id: media._id.toString(),
      url: media.url ?? '',
      purpose: media.purpose,
      contentType: media.contentType,
      sizeBytes: media.sizeBytes,
      status: media.status,
      durationSeconds: media.durationSeconds,
    };
  }
}
