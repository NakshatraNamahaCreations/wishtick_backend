import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from 'src/config/configuration';
import { signedDirectoryUrl } from '../bunny-token';
import { VideoState, type IVideoProvider, type VideoInfo } from '../video.port';

/** An upstream failure, carrying the status so a caller can tell 404 from 500. */
export class BunnyStreamHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'BunnyStreamHttpError';
  }
}

/** `status` on a Bunny Stream video object. */
const enum BunnyVideoStatus {
  CREATED = 0,
  UPLOADED = 1,
  PROCESSING = 2,
  TRANSCODING = 3,
  FINISHED = 4,
  ERROR = 5,
  UPLOAD_FAILED = 6,
}

@Injectable()
export class BunnyStreamAdapter implements IVideoProvider {
  private static readonly apiBase = 'https://video.bunnycdn.com';

  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  private get cfg() {
    return this.config.get('video', { infer: true }).bunny;
  }

  get enabled(): boolean {
    return this.config.get('video', { infer: true }).driver === 'bunny_stream';
  }

  async ingest(input: { title: string; sourceUrl: string }): Promise<{ videoId: string }> {
    // Two calls, not one: Bunny mints the id first, then pulls the bytes
    // against it. Splitting them means a failed pull leaves a video we can
    // retry or delete, rather than an upload with no handle.
    const created = await this.call<{ guid: string }>(
      'POST',
      `/library/${this.cfg.libraryId}/videos`,
      {
        title: input.title,
      },
    );

    try {
      await this.call('POST', `/library/${this.cfg.libraryId}/videos/${created.guid}/fetch`, {
        url: input.sourceUrl,
      });
    } catch (err) {
      // Do not leave an empty video behind; it would sit in the library
      // forever reporting "processing".
      await this.delete(created.guid).catch(() => undefined);
      throw err;
    }

    return { videoId: created.guid };
  }

  async info(videoId: string): Promise<VideoInfo> {
    const video = await this.call<{
      status: number;
      encodeProgress?: number;
      length?: number;
      thumbnailFileName?: string;
    }>('GET', `/library/${this.cfg.libraryId}/videos/${videoId}`);

    return {
      state: BunnyStreamAdapter.toState(video.status),
      progress: video.encodeProgress ?? 0,
      durationSeconds: video.length && video.length > 0 ? video.length : null,
      thumbnailFileName: video.thumbnailFileName ?? null,
    };
  }

  /**
   * A signed HLS master playlist URL, valid for the configured window.
   *
   * Uses a *directory* token so the segments the playlist references are
   * covered too — see `bunny-token.ts`.
   */
  playbackUrl(videoId: string): string {
    return signedDirectoryUrl({
      securityKey: this.cfg.tokenKey,
      hostname: this.cfg.cdnHostname,
      directory: videoId,
      file: 'playlist.m3u8',
      ttlSeconds: this.cfg.tokenTtlSeconds,
    });
  }

  thumbnailUrl(videoId: string, fileName: string): string {
    return signedDirectoryUrl({
      securityKey: this.cfg.tokenKey,
      hostname: this.cfg.cdnHostname,
      directory: videoId,
      file: fileName,
      ttlSeconds: this.cfg.tokenTtlSeconds,
    });
  }

  async delete(videoId: string): Promise<void> {
    await this.call('DELETE', `/library/${this.cfg.libraryId}/videos/${videoId}`);
  }

  private static toState(status: BunnyVideoStatus): VideoState {
    switch (status) {
      case BunnyVideoStatus.FINISHED:
        return VideoState.READY;
      case BunnyVideoStatus.ERROR:
      case BunnyVideoStatus.UPLOAD_FAILED:
        return VideoState.FAILED;
      case BunnyVideoStatus.CREATED:
        return VideoState.PENDING;
      default:
        return VideoState.PROCESSING;
    }
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${BunnyStreamAdapter.apiBase}${path}`, {
      method,
      headers: {
        AccessKey: this.cfg.apiKey,
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new BunnyStreamHttpError(
        response.status,
        `Bunny Stream ${method} ${path} → ${response.status}: ${text.slice(0, 300)}`,
      );
    }

    // DELETE answers 200 with a body, but nothing reads it.
    const text = await response.text();
    return (text ? JSON.parse(text) : {}) as T;
  }
}
