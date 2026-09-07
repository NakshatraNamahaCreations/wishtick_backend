export const VIDEO = Symbol('VIDEO');

/** Where an upload has got to inside the encoder. */
export enum VideoState {
  /** Registered, bytes not fully in yet. */
  PENDING = 'pending',
  /** Bunny has the bytes and is transcoding. Not playable. */
  PROCESSING = 'processing',
  /** Playable. */
  READY = 'ready',
  FAILED = 'failed',
}

export interface VideoInfo {
  state: VideoState;
  /** 0–100 while encoding, for a progress bar. */
  progress: number;
  durationSeconds: number | null;
  /** Relative file name of the generated poster frame, when there is one. */
  thumbnailFileName: string | null;
}

/**
 * A transcoding video host, behind one interface so the app never learns
 * whether a clip is a flat file in object storage or an HLS ladder at a vendor.
 *
 * Separate from `IStorageProvider` because the lifecycle genuinely differs: an
 * image is usable the instant its bytes land, whereas a video is *registered*,
 * then encoded, and only then playable. Modelling that as a storage write
 * would mean pretending a file is ready when it is not.
 */
export interface IVideoProvider {
  /**
   * False when video is left in ordinary object storage — the local-dev case.
   * Callers branch on this rather than on a config string, so there is one
   * place that decides.
   */
  readonly enabled: boolean;

  /**
   * Registers a video and tells the host to pull it from [sourceUrl].
   *
   * Pull rather than push on purpose: the phone has already uploaded the file
   * once, to storage, using a presigned PUT it can do with a plain HTTP client.
   * Handing the vendor a URL keeps that single client-side upload — the
   * alternative, a resumable direct-to-vendor protocol, would mean a new
   * dependency on the phone and a signing dance on every chunk.
   */
  ingest(input: { title: string; sourceUrl: string }): Promise<{ videoId: string }>;

  info(videoId: string): Promise<VideoInfo>;

  /**
   * A short-lived signed URL for the HLS master playlist.
   *
   * Minted per request, never stored: the token expires, and `media.url` is
   * snapshotted into wishlists, memories, events and thank-you notes at attach
   * time. A stored signed URL would rot in eight collections at once.
   */
  playbackUrl(videoId: string): string;

  thumbnailUrl(videoId: string, fileName: string): string;

  delete(videoId: string): Promise<void>;
}
