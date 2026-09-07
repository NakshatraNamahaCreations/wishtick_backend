import { Injectable } from '@nestjs/common';
import type { IVideoProvider, VideoInfo } from '../video.port';

/**
 * The no-transcoding case: video stays a flat file in object storage.
 *
 * Right for local dev, where reaching a vendor to watch a two-second test clip
 * would be absurd. Wrong for anyone on mobile data — a flat file cannot drop
 * its bitrate when the connection does, so it buffers instead of degrading.
 *
 * Every method throws rather than returning something plausible: [enabled] is
 * false, so the only way to reach one of these is a caller that forgot to
 * check, and a silent no-op there would look like a video that never finishes
 * encoding.
 */
@Injectable()
export class PassthroughVideoAdapter implements IVideoProvider {
  readonly enabled = false;

  private static unreachable(method: string): never {
    throw new Error(
      `VideoProvider.${method} called while VIDEO_DRIVER=storage — ` +
        'check `enabled` before routing video to a transcoder',
    );
  }

  ingest(): Promise<{ videoId: string }> {
    PassthroughVideoAdapter.unreachable('ingest');
  }

  info(): Promise<VideoInfo> {
    PassthroughVideoAdapter.unreachable('info');
  }

  playbackUrl(): string {
    PassthroughVideoAdapter.unreachable('playbackUrl');
  }

  thumbnailUrl(): string {
    PassthroughVideoAdapter.unreachable('thumbnailUrl');
  }

  delete(): Promise<void> {
    PassthroughVideoAdapter.unreachable('delete');
  }
}
