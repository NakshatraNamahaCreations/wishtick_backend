import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectModel } from '@nestjs/mongoose';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { Model } from 'mongoose';
import { REEL_RELEASED, type ReelReleasedEvent } from 'src/common/events/domain-events';
import type { AppConfig } from 'src/config/configuration';
import { STORAGE, type IStorageProvider } from 'src/infra/storage/storage.port';
import { FfmpegService } from './ffmpeg.service';
import { ReelCardRenderer } from './reel-card.renderer';
import { ModerationStatus, REEL_VIDEO, ReelStatus, WishKind } from './reel.types';
import { ReelCollection, type ReelCollectionDocument } from './schemas/reel-collection.schema';
import { Wish, type WishDocument } from './schemas/wish.schema';

const TEXT_CARD_SECONDS = 4;
const { width: W, height: H, fps: FPS, audioSampleRate: AR, audioChannels: AC } = REEL_VIDEO;

/**
 * Compiles a collection's approved wishes into one reel MP4.
 *
 * The exit-criteria discipline lives here:
 *  - **Process isolation + timeout** — every ffmpeg step is a separate,
 *    hard-timed child process (FfmpegService).
 *  - **Temp hygiene** — a deterministic per-collection scratch dir is wiped at
 *    the START (clearing any orphan a killed prior attempt left) and again in a
 *    `finally`, so no exit path — success, throw, or a retry after SIGKILL —
 *    leaves temp behind.
 *  - **Partial failure** — one unprocessable wish is skipped and logged; the
 *    reel still ships with the rest.
 *  - **Idempotent resume** — a re-run rebuilds from scratch, so a retry after a
 *    mid-render kill produces a correct reel.
 */
@Injectable()
export class ReelCompileService {
  private readonly logger = new Logger(ReelCompileService.name);

  constructor(
    @InjectModel(ReelCollection.name)
    private readonly collectionModel: Model<ReelCollectionDocument>,
    @InjectModel(Wish.name) private readonly wishModel: Model<WishDocument>,
    @Inject(STORAGE) private readonly storage: IStorageProvider,
    private readonly ffmpeg: FfmpegService,
    private readonly cards: ReelCardRenderer,
    private readonly emitter: EventEmitter2,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  async compile(collectionId: string): Promise<{ released: boolean; wishesUsed: number }> {
    const collection = await this.collectionModel.findById(collectionId).exec();
    if (!collection) return { released: false, wishesUsed: 0 };
    // Idempotent: a redelivered job for an already-released reel is a no-op.
    if (collection.status === ReelStatus.RELEASED) {
      return { released: true, wishesUsed: 0 };
    }

    const dir = path.resolve(
      this.config.get('reels.tempDir', { infer: true }),
      `reel-${collectionId}`,
    );
    // Clean slate: remove any orphan a killed prior attempt left behind.
    await fs.rm(dir, { recursive: true, force: true });
    await fs.mkdir(dir, { recursive: true });

    try {
      const recipientName = await this.recipientName(collection);
      const wishes = await this.wishModel
        .find({ collectionId: collection._id, moderationStatus: ModerationStatus.APPROVED })
        .sort({ order: 1, _id: 1 })
        .exec();

      const clips: string[] = [];
      clips.push(
        await this.renderCard(this.cards.intro({ recipientName }), dir, 'intro', TEXT_CARD_SECONDS),
      );

      let index = 0;
      for (const wish of wishes) {
        try {
          const clip = await this.renderWishClip(wish, dir, index);
          if (clip) {
            clips.push(clip);
            index += 1;
          }
        } catch (err) {
          // Partial-failure policy: skip the unprocessable wish, keep the rest.
          this.logger.warn(
            `Skipping wish ${wish._id.toString()} in reel ${collectionId}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }

      clips.push(await this.renderCard(this.cards.outro(), dir, 'outro', TEXT_CARD_SECONDS));

      const concatPath = await this.concat(clips, dir);
      const reelPath = await this.finalize(concatPath, dir);
      const probe = await this.ffmpeg.probe(reelPath);

      const storageKey = `reels/${collectionId}/reel-${Date.now()}.mp4`;
      const bytes = await fs.readFile(reelPath);
      await this.storage.putObject(storageKey, bytes, 'video/mp4');

      collection.status = ReelStatus.RELEASED;
      collection.reelStorageKey = storageKey;
      collection.reelMediaUrl = this.storage.getPublicUrl(storageKey);
      collection.durationMs = probe.durationMs;
      collection.failureReason = null;
      await collection.save();

      this.emitter.emit(REEL_RELEASED, {
        reelId: collectionId,
        recipientId: collection.recipientUserId.toString(),
        wishCount: index,
        reelMediaUrl: collection.reelMediaUrl,
      } satisfies ReelReleasedEvent);

      this.logger.log(`Reel ${collectionId} released with ${index} wishes (${probe.durationMs}ms)`);
      return { released: true, wishesUsed: index };
    } finally {
      // Cleanup on EVERY exit path — success, throw, or timeout.
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** Marks a collection failed after retries are exhausted (worker calls this). */
  async markFailed(collectionId: string, reason: string): Promise<void> {
    await this.collectionModel
      .updateOne(
        { _id: collectionId },
        { $set: { status: ReelStatus.FAILED, failureReason: reason.slice(0, 500) } },
      )
      .exec();
    this.logger.error(`Reel ${collectionId} failed to compile: ${reason}`);
  }

  // ── Clip rendering ──────────────────────────────────────────────────────────

  private async renderWishClip(
    wish: WishDocument,
    dir: string,
    index: number,
  ): Promise<string | null> {
    const out = path.join(dir, `wish-${String(index).padStart(3, '0')}.mp4`);
    if (wish.kind === WishKind.TEXT) {
      const card = this.cards.textWish({ authorName: wish.authorName, text: wish.text ?? '' });
      return this.renderCard(card, dir, `wish-${index}`, TEXT_CARD_SECONDS, out);
    }

    // Audio/video: pull the real bytes from storage to a temp input file.
    if (!wish.storageKey) return null;
    const { body } = await this.storage.getObject(wish.storageKey);
    const input = path.join(dir, `src-${index}`);
    await fs.writeFile(input, body);
    const maxMs =
      wish.kind === WishKind.VIDEO
        ? this.config.get('reels.maxVideoDurationMs', { infer: true })
        : this.config.get('reels.maxAudioDurationMs', { infer: true });
    const maxSec = (maxMs / 1000).toFixed(2);

    if (wish.kind === WishKind.VIDEO) {
      await this.ffmpeg.run([
        '-i',
        input,
        '-t',
        maxSec,
        ...ReelCompileService.videoNormalize(),
        out,
      ]);
    } else {
      // Audio wish: a still author card over the audio track.
      const cardPath = path.join(dir, `audiocard-${index}.png`);
      await fs.writeFile(cardPath, this.cards.audioWish({ authorName: wish.authorName }));
      await this.ffmpeg.run([
        '-loop',
        '1',
        '-i',
        cardPath,
        '-i',
        input,
        '-t',
        maxSec,
        '-shortest',
        ...ReelCompileService.videoNormalize(),
        out,
      ]);
    }
    return out;
  }

  /** A still PNG → a fixed-duration clip with silent audio. */
  private async renderCard(
    png: Buffer,
    dir: string,
    name: string,
    seconds: number,
    outPath?: string,
  ): Promise<string> {
    const cardPath = path.join(dir, `${name}.png`);
    const out = outPath ?? path.join(dir, `${name}.mp4`);
    await fs.writeFile(cardPath, png);
    await this.ffmpeg.run([
      '-loop',
      '1',
      '-i',
      cardPath,
      '-f',
      'lavfi',
      '-i',
      `anullsrc=r=${AR}:cl=stereo`,
      '-t',
      String(seconds),
      '-shortest',
      ...ReelCompileService.videoNormalize(),
      out,
    ]);
    return out;
  }

  private async concat(clips: string[], dir: string): Promise<string> {
    const listPath = path.join(dir, 'list.txt');
    // ffmpeg concat demuxer wants forward slashes even on Windows.
    const list = clips.map((c) => `file '${c.replace(/\\/g, '/')}'`).join('\n');
    await fs.writeFile(listPath, list);
    const out = path.join(dir, 'concat.mp4');
    await this.ffmpeg.run(['-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', out]);
    return out;
  }

  /** Overlay the watermark and duck a music bed under the wishes. */
  private async finalize(concatPath: string, dir: string): Promise<string> {
    const probe = await this.ffmpeg.probe(concatPath);
    const seconds = Math.max(1, probe.durationMs / 1000).toFixed(2);
    const watermarkPath = path.join(dir, 'watermark.png');
    await fs.writeFile(
      watermarkPath,
      this.cards.watermark(this.config.get('reels.watermark', { infer: true })),
    );
    const out = path.join(dir, 'reel.mp4');
    await this.ffmpeg.run([
      '-i',
      concatPath,
      '-i',
      watermarkPath,
      // A soft synthesized music bed (a licensed track can replace this later).
      '-f',
      'lavfi',
      '-t',
      seconds,
      '-i',
      `sine=frequency=396:sample_rate=${AR}`,
      '-filter_complex',
      `[0:v][1:v]overlay=0:0[v];[2:a]volume=0.10[m];[0:a][m]amix=inputs=2:duration=first:dropout_transition=0[a]`,
      '-map',
      '[v]',
      '-map',
      '[a]',
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-c:a',
      'aac',
      '-ar',
      String(AR),
      '-ac',
      String(AC),
      '-shortest',
      out,
    ]);
    return out;
  }

  /** The canonical normalize every clip shares, so the concat demuxer can copy. */
  private static videoNormalize(): string[] {
    return [
      '-vf',
      `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${FPS},format=yuv420p`,
      '-af',
      'aresample=async=1,loudnorm=I=-16:TP=-1.5:LRA=11',
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-ar',
      String(AR),
      '-ac',
      String(AC),
      '-video_track_timescale',
      '30000',
    ];
  }

  private async recipientName(collection: ReelCollectionDocument): Promise<string> {
    // The collection title already reads "X's Birthday"; use the recipient's name
    // when we can, else fall back to the title.
    const user = await this.collectionModel.db
      .collection('users')
      .findOne({ _id: collection.recipientUserId });
    const name = (user?.name as string | undefined)?.trim();
    return name || collection.title;
  }
}
