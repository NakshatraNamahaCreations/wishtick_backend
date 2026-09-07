export enum ReportTargetType {
  WISH = 'wish',
  REEL = 'reel',
  MESSAGE = 'message',
  WISHLIST = 'wishlist',
  EVENT = 'event',
  USER = 'user',
}

export enum ReportStatus {
  OPEN = 'open',
  REVIEWING = 'reviewing',
  RESOLVED = 'resolved',
  DISMISSED = 'dismissed',
}

export enum ReportSource {
  /** A user hit "report". */
  USER = 'user',
  /** An auto-flag hook (profanity, future media safety) raised it. */
  AUTO = 'auto',
}

/** The actions a moderator can take on a report/target. */
export enum ModerationAction {
  /** The content is fine — dismiss the report, leave it up. */
  APPROVE = 'approve',
  /** Take the content down (soft-hide / regenerate / suspend as appropriate). */
  REMOVE = 'remove',
  /** Leave it up but keep it flagged for a second look. */
  FLAG = 'flag',
  /** Bump severity for a senior reviewer. */
  ESCALATE = 'escalate',
}

/** Higher = reviewed sooner. Auto-flagged content and reports on people rank up. */
export function severityFor(targetType: ReportTargetType, source: ReportSource): number {
  let severity = 1;
  if (targetType === ReportTargetType.USER) severity += 2;
  if (targetType === ReportTargetType.MESSAGE || targetType === ReportTargetType.WISH)
    severity += 1;
  if (source === ReportSource.AUTO) severity += 1;
  return severity;
}

/**
 * A reported target, normalized across every content type.
 *
 * The moderation queue only stores `targetType` + `targetId`, which is not
 * enough to judge anything — a moderator asked to remove `6660bb2e…41` is being
 * asked to act blind. This is the shape that makes a takedown decision possible:
 * one envelope the UI can render regardless of what was reported.
 */
export interface ModerationTargetView {
  targetType: ReportTargetType;
  targetId: string;
  /**
   * False when the underlying document is gone (hard-deleted, or a malformed
   * id). The report still exists and is still actionable — the UI needs to say
   * "this content no longer exists" rather than render an empty card.
   */
  exists: boolean;
  /** Headline — a wishlist/event title, or a label for types that have none. */
  title: string | null;
  /** The actual reported words, where the type has any. */
  body: string | null;
  /** Attached media, if the type carries any. */
  mediaUrl: string | null;
  /** The account that produced the content, for repeat-offender context. */
  authorId: string | null;
  /**
   * Current lifecycle state — `deleted`, `archived`, `cancelled`, `rejected`,
   * `suspended`. Non-null means a takedown already happened, so a second
   * `remove` would be a no-op.
   */
  state: string | null;
  createdAt: Date | null;
  /** Type-specific extras, rendered as a label/value list. */
  fields: Record<string, string | number | boolean | null>;
}
