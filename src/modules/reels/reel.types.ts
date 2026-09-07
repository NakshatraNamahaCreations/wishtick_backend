/**
 * The lifecycle of a wish collection.
 *
 *   collecting → locked      (submission deadline passed / manually sealed)
 *   locked     → releasing   (the timezone-correct release job fires)
 *   releasing  → released     (compilation succeeded)
 *   releasing  → failed       (compilation exhausted its retries)
 *   failed     → releasing    (admin regenerate)
 *
 * `collecting` and `locked` are the only states in which wish CONTENT is
 * withheld from every surface — the time-lock. Everything reads this table; the
 * status is the single source of "is the reel out yet".
 */
export enum ReelStatus {
  COLLECTING = 'collecting',
  LOCKED = 'locked',
  RELEASING = 'releasing',
  RELEASED = 'released',
  FAILED = 'failed',
}

export enum WishKind {
  TEXT = 'text',
  AUDIO = 'audio',
  VIDEO = 'video',
}

export enum ModerationStatus {
  PENDING = 'pending',
  APPROVED = 'approved',
  REJECTED = 'rejected',
}

export const REEL_TRANSITIONS: Record<ReelStatus, ReelStatus[]> = {
  [ReelStatus.COLLECTING]: [ReelStatus.LOCKED],
  [ReelStatus.LOCKED]: [ReelStatus.RELEASING],
  [ReelStatus.RELEASING]: [ReelStatus.RELEASED, ReelStatus.FAILED],
  [ReelStatus.RELEASED]: [],
  [ReelStatus.FAILED]: [ReelStatus.RELEASING],
};

/**
 * Statuses in which wish content (text, media, the compiled reel) is readable.
 * ANY surface that returns wish content must gate on this — see ReelViews. Before
 * `released`, only metadata (counts, first names) ever leaves the server.
 */
export const CONTENT_VISIBLE_STATUSES: ReelStatus[] = [ReelStatus.RELEASED];

/** Statuses in which the collection still accepts new wishes. */
export const SUBMITTABLE_STATUSES: ReelStatus[] = [ReelStatus.COLLECTING];

/** The canonical output geometry every clip is normalized to before concat. */
export const REEL_VIDEO = {
  width: 720,
  height: 1280,
  fps: 30,
  audioSampleRate: 44_100,
  audioChannels: 2,
} as const;
