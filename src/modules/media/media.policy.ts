import { MediaPurpose } from './schemas/media.schema';

export interface PurposeRule {
  mimeTypes: string[];
  maxBytes: number;
  /**
   * How long a clip may run, where a duration is knowable at all.
   *
   * Separate from [maxBytes] because they refuse different things: a size cap
   * is about what we pay to store and how long an upload takes, a duration cap
   * is about what anyone will sit through. A well-compressed five-minute video
   * can slip under 10 MB, and a 15-second one shot on a modern phone can blow
   * past it — neither limit implies the other.
   *
   * Undefined means "no ceiling", not "zero".
   */
  maxDurationSeconds?: number;
  /** Extension used for the storage key, keyed by mime type. */
  extensions: Record<string, string>;
}

const MB = 1024 * 1024;

const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
};

const IMAGE_TYPES = Object.keys(IMAGE_EXTENSIONS);

/**
 * Per-purpose allowlists. Allowlists, never denylists: a denylist is a promise
 * to have thought of every dangerous type, and `image/svg+xml` alone is stored
 * XSS if it is ever served from our origin.
 *
 * Limits are per-purpose because they are not the same problem — a 10 MB avatar
 * is absurd, a 10 MB birthday video is normal.
 */
export const MEDIA_RULES: Record<MediaPurpose, PurposeRule> = {
  [MediaPurpose.PROFILE_PHOTO]: {
    mimeTypes: IMAGE_TYPES,
    maxBytes: 5 * MB,
    extensions: IMAGE_EXTENSIONS,
  },
  [MediaPurpose.EVENT_COVER]: {
    mimeTypes: IMAGE_TYPES,
    maxBytes: 8 * MB,
    extensions: IMAGE_EXTENSIONS,
  },
  // `2248:70` offers JPG, PNG, GIF, MP4 and PDF up to 10 MB. GIF and PDF are
  // allowed *here only*: both are served as attachments from the media origin,
  // never inlined into a page, so neither becomes stored XSS.
  [MediaPurpose.EVENT_INVITE]: {
    mimeTypes: [...IMAGE_TYPES, 'image/gif', 'video/mp4', 'application/pdf'],
    maxBytes: 10 * MB,
    extensions: {
      ...IMAGE_EXTENSIONS,
      'image/gif': 'gif',
      'video/mp4': 'mp4',
      'application/pdf': 'pdf',
    },
  },
  [MediaPurpose.MEMORY_COVER]: {
    mimeTypes: IMAGE_TYPES,
    maxBytes: 8 * MB,
    extensions: IMAGE_EXTENSIONS,
  },
  // A wish may be a photo, a video or a voice note (`2073:55`, `2074:129`,
  // `2074:152`). Roomier than a cover and tighter than a reel clip.
  //
  // 20 seconds because a wish is a greeting, not a film: it is watched in a
  // story viewer, one wish after another, and a capsule of twenty of them is
  // already seven minutes. The cap applies to what is uploaded — a video wish
  // IS re-encoded when a Stream driver is configured, but that happens after
  // the phone has sent the whole file, so it does nothing for the upload.
  [MediaPurpose.MEMORY_WISH]: {
    mimeTypes: [
      ...IMAGE_TYPES,
      'video/mp4',
      'video/quicktime',
      'audio/mpeg',
      'audio/mp4',
      'audio/aac',
      'audio/wav',
    ],
    maxBytes: 50 * MB,
    maxDurationSeconds: 20,
    extensions: {
      ...IMAGE_EXTENSIONS,
      'video/mp4': 'mp4',
      'video/quicktime': 'mov',
      'audio/mpeg': 'mp3',
      'audio/mp4': 'm4a',
      'audio/aac': 'aac',
      'audio/wav': 'wav',
    },
  },
  // A reply travels back to the people who filled a capsule. Deliberately the
  // same envelope as the wish it answers — it is composed on the same screen,
  // and a reply someone may not send at the length they were sent would be a
  // strange asymmetry.
  [MediaPurpose.MEMORY_REPLY]: {
    mimeTypes: [
      ...IMAGE_TYPES,
      'video/mp4',
      'video/quicktime',
      'audio/mpeg',
      'audio/mp4',
      'audio/aac',
      'audio/wav',
    ],
    maxBytes: 50 * MB,
    maxDurationSeconds: 20,
    extensions: {
      ...IMAGE_EXTENSIONS,
      'video/mp4': 'mp4',
      'video/quicktime': 'mov',
      'audio/mpeg': 'mp3',
      'audio/mp4': 'm4a',
      'audio/aac': 'aac',
      'audio/wav': 'wav',
    },
  },
  // A thank-you may be a photo, a video or a voice note (`2015:271`,
  // `2015:382`, `2209:104`). Same envelope as a memory wish — one person
  // recording one short reply — so the limits match deliberately.
  [MediaPurpose.THANK_YOU]: {
    mimeTypes: [
      ...IMAGE_TYPES,
      'video/mp4',
      'video/quicktime',
      'audio/mpeg',
      'audio/mp4',
      'audio/aac',
      'audio/wav',
    ],
    maxBytes: 50 * MB,
    extensions: {
      ...IMAGE_EXTENSIONS,
      'video/mp4': 'mp4',
      'video/quicktime': 'mov',
      'audio/mpeg': 'mp3',
      'audio/mp4': 'm4a',
      'audio/aac': 'aac',
      'audio/wav': 'wav',
    },
  },
  [MediaPurpose.WISHLIST_ITEM]: {
    mimeTypes: IMAGE_TYPES,
    maxBytes: 8 * MB,
    extensions: IMAGE_EXTENSIONS,
  },
  [MediaPurpose.WISHLIST_COVER]: {
    mimeTypes: IMAGE_TYPES,
    maxBytes: 8 * MB,
    extensions: IMAGE_EXTENSIONS,
  },
  // Sprint 10 compiles these into a reel. Video and audio are allowed here and
  // nowhere else; ffprobe re-validates duration and codec at compile time.
  [MediaPurpose.REEL_WISH]: {
    mimeTypes: [
      ...IMAGE_TYPES,
      'video/mp4',
      'video/quicktime',
      'video/webm',
      'audio/mpeg',
      'audio/mp4',
      'audio/aac',
      'audio/wav',
      'audio/webm',
    ],
    maxBytes: 100 * MB,
    extensions: {
      ...IMAGE_EXTENSIONS,
      'video/mp4': 'mp4',
      'video/quicktime': 'mov',
      'video/webm': 'webm',
      'audio/mpeg': 'mp3',
      'audio/mp4': 'm4a',
      'audio/aac': 'aac',
      'audio/wav': 'wav',
      'audio/webm': 'weba',
    },
  },
};
