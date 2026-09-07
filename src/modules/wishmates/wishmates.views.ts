/**
 * How one user appears to another.
 *
 * Everything here is public by design — a handle, a display name and a photo
 * are what the search and request screens show about someone you have not
 * connected to yet. Nothing that identifies a person off-platform (email,
 * phone, delivery address) is ever projected into this shape, which is why the
 * service builds it explicitly rather than spreading a profile document.
 */
export interface PublicIdentity {
  userId: string;
  username: string | null;
  displayName: string | null;
  photoUrl: string | null;

  /**
   * One of the twenty bundled avatars (`avatar_01` … `avatar_20`), when they
   * picked one instead of uploading a photo.
   *
   * Carried alongside [photoUrl] rather than resolved into it, because the
   * asset lives in the app bundle and has no URL the server could hand out.
   * Without this field every account that chose a bundled avatar — which is
   * most of them, since it is what onboarding offers first — appears to
   * everybody *else* as a bare initial, while looking correct to its owner.
   */
  avatarKey: string | null;

  /** Whether they hold a live socket right now — the green dot. */
  online: boolean;
  /** ISO, or null for someone never seen since presence was introduced. */
  lastSeenAt: string | null;
}

/**
 * An identity plus how the viewer stands beside it.
 *
 * [PublicIdentity] is split out because not every caller has a viewer-relative
 * context to fill in: the chat list names the person on the other side of a
 * thread and has no use for a mutual count. Sending `mutualCount: 0` there
 * would be a number that is wrong rather than absent.
 */
export interface WishmateView extends PublicIdentity {
  /** How many accepted wishmates the viewer and this person share. */
  mutualCount: number;
}

/** Where the viewer stands with someone, which decides the profile's buttons. */
export enum WishmateRelationship {
  /** No link at all — the profile offers "Add WishMate". */
  NONE = 'none',
  /** The viewer asked and is waiting — the profile offers to withdraw. */
  REQUEST_SENT = 'request_sent',
  /** They asked the viewer — the profile offers Accept / Decline. */
  REQUEST_RECEIVED = 'request_received',
  /** Connected — the profile offers "Remove WishMate". */
  WISHMATES = 'wishmates',
  /** The viewer looking at themselves. No relationship buttons at all. */
  SELF = 'self',
}

/** One pending request, in either direction. */
export interface WishLinkView {
  linkId: string;
  person: WishmateView;
  createdAt: string;
}

/**
 * One thing a viewer is allowed to know about someone else's calendar —
 * "Recent Activity" on `4177:267`.
 *
 * The rule is deliberately the narrowest one that needs no further permission:
 * an event appears here **only when the viewer was invited to it too**, and
 * only when both of them are actually going. Someone's calendar is not public
 * information, and "you are shown what you were already shown" is the only
 * scoping that cannot leak. A wider rule — every event they RSVP'd to, or every
 * public event — would turn a profile into a movement log, which is a privacy
 * decision no frame in this set makes.
 */
export interface WishmateActivityView {
  eventId: string;
  title: string;
  type: string;
  /** ISO, UTC. */
  startsAt: string;
  /** The event's own timezone — "24 July 2026" means the day where it happens. */
  timezone: string;
  venue: string | null;
  /** Their answer: only `yes` or `maybe` ever reach here. */
  rsvp: string;
  /** The viewer's own answer to the same event, for the same reason. */
  viewerRsvp: string;
}

/** The public profile screen (`4177:217` / `4177:267`). */
export interface WishmateProfileView {
  person: WishmateView;
  relationship: WishmateRelationship;
  city: string | null;
  country: string | null;
  joinedAt: string;
  /**
   * A handful of the mutual wishmates, for the avatar stack beside the count.
   * The count in [WishmateView.mutualCount] is the total; this is only what
   * the stack has room to draw.
   */
  mutuals: WishmateView[];
  /**
   * Upcoming events both of them are going to, soonest first. Empty for a
   * viewer who shares no event with this person — which is most viewers, and
   * is why `4177:267`'s section is hidden rather than shown empty.
   */
  recentActivity: WishmateActivityView[];
}
