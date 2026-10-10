import { Types } from 'mongoose';
import { VideoState } from 'src/infra/video/video.port';
import { MediaService } from './media.service';
import { MediaPurpose, MediaStatus } from './schemas/media.schema';

/**
 * Where a video wish's stable link points while Bunny encodes it, and after.
 *
 * Bunny's shared queue has held clips for 11–13 minutes before starting them
 * (the encode itself takes seconds). The original is on the CDN for all of
 * that time, so it plays rather than nobody being able to watch the wish.
 */
describe('MediaService playback while encoding', () => {
  const ORIGINAL = 'https://cdn.test/users/u1/memory_wish/clip.mp4';
  const LADDER = 'https://stream.test/vid/playlist.m3u8';
  const MP4 = 'https://stream.test/vid/play_720p.mp4';

  function setup(state: VideoState) {
    const media = {
      _id: new Types.ObjectId(),
      purpose: MediaPurpose.MEMORY_WISH,
      status: MediaStatus.PROCESSING,
      videoId: 'vid',
      storageKey: 'users/u1/memory_wish/clip.mp4',
      save: jest.fn().mockResolvedValue(undefined),
    };
    const storage = {
      getPublicUrl: jest.fn(() => ORIGINAL),
      delete: jest.fn().mockResolvedValue(undefined),
    };
    const video = {
      enabled: true,
      info: jest.fn().mockResolvedValue({
        state,
        durationSeconds: 8,
        thumbnailFileName: 'thumb.jpg',
      }),
      playbackUrl: jest.fn(() => LADDER),
      downloadUrl: jest.fn().mockResolvedValue(MP4),
      delete: jest.fn(),
    };
    const service = new MediaService(
      { findById: () => ({ exec: () => Promise.resolve(media) }) } as never,
      storage as never,
      video as never,
      { get: () => undefined } as never,
    );
    return { service, media, storage };
  }

  it('plays the original while the encode is still queued', async () => {
    const { service, media } = setup(VideoState.PROCESSING);

    await expect(service.playbackUrl(media._id.toString())).resolves.toBe(ORIGINAL);
    await expect(service.downloadUrl(media._id.toString())).resolves.toBe(ORIGINAL);
  });

  it('switches to the encoded copy the moment the encode lands', async () => {
    const { service, media, storage } = setup(VideoState.READY);

    await expect(service.playbackUrl(media._id.toString())).resolves.toBe(LADDER);
    expect(media.status).toBe(MediaStatus.READY);
    // And only then is the original let go.
    expect(storage.delete).toHaveBeenCalledWith(media.storageKey);
  });

  it('still refuses a clip the encoder could not handle', async () => {
    const { service, media } = setup(VideoState.FAILED);

    await expect(service.playbackUrl(media._id.toString())).rejects.toMatchObject({
      status: 404,
    });
  });
});
