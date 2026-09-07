/**
 * The lifecycle of a memory capsule.
 *
 *   collecting → locked     (the unlock instant approaches / the host seals it)
 *   locked     → unlocked   (the scheduled unlock job fires)
 *
 * `collecting` and `locked` are the only states in which wish CONTENT is
 * withheld from every surface — the time-lock. Everything reads this field; the
 * status is the single source of "is the memory open yet".
 *
 * Deliberately shorter than ReelStatus: a memory is browsed wish by wish, so
 * there is no compilation step that can be in-flight or fail.
 */
export enum MemoryStatus {
  COLLECTING = 'collecting',
  LOCKED = 'locked',
  UNLOCKED = 'unlocked',
}

/**
 * What a contributed wish is.
 *
 * PHOTO has no counterpart in `WishKind` (the reels module compiles video, and
 * a still is not a clip). It is the default kind here — `2073:55` is the first
 * screen the add-a-wish flow offers.
 */
export enum MemoryWishKind {
  PHOTO = 'photo',
  TEXT = 'text',
  AUDIO = 'audio',
  VIDEO = 'video',
}

export const MEMORY_TRANSITIONS: Record<MemoryStatus, MemoryStatus[]> = {
  [MemoryStatus.COLLECTING]: [MemoryStatus.LOCKED, MemoryStatus.UNLOCKED],
  [MemoryStatus.LOCKED]: [MemoryStatus.UNLOCKED],
  [MemoryStatus.UNLOCKED]: [],
};

/**
 * Statuses in which wish content is readable.
 *
 * ANY surface that returns wish content must gate on this — see memory.views.
 * Before `unlocked`, only metadata (counts, contributor first names) ever
 * leaves the server. A capsule whose contents leak early is not a surprise.
 */
export const MEMORY_CONTENT_VISIBLE: MemoryStatus[] = [MemoryStatus.UNLOCKED];

/** Statuses in which the capsule still accepts new wishes. */
export const MEMORY_SUBMITTABLE: MemoryStatus[] = [MemoryStatus.COLLECTING];

/** Which wish kinds carry a media file, and which are text alone. */
export const MEMORY_KINDS_WITH_MEDIA: MemoryWishKind[] = [
  MemoryWishKind.PHOTO,
  MemoryWishKind.AUDIO,
  MemoryWishKind.VIDEO,
];

/**
 * The message field's cap, as the frames count it ("40/100" on `2073:55`,
 * `2078:233`, `2074:129`).
 */
export const MEMORY_WISH_TEXT_MAX = 100;

/** A capsule cannot collect forever; the scheduler would hold a job for years. */
export const MEMORY_MAX_UNLOCK_YEARS = 5;

/**
 * How many people one reply may be addressed to.
 *
 * Generous — a capsule holds up to 60 wishes, and someone with several opened
 * memories could legitimately want to thank everyone at once. It is here to
 * bound the notification fan-out, not to second-guess the sender.
 */
export const MEMORY_REPLY_MAX_RECIPIENTS = 100;
