import type { PublicIdentity } from 'src/modules/wishmates/wishmates.views';
import { MEMORY_CONTENT_VISIBLE, MemoryStatus } from './memory.types';
import type { MemoryCapsuleDocument } from './schemas/memory-capsule.schema';
import type { MemoryReplyDocument } from './schemas/memory-reply.schema';
import type { MemoryWishDocument } from './schemas/memory-wish.schema';

/**
 * A sealed memory, as the person it is for may know it: that it is coming,
 * what for, and when it opens.
 *
 * Deliberately nothing else. Not who made it, not who wrote in it, not its
 * title or cover — the surprise is *what* is inside and *who* is behind it,
 * and none of that is in this shape. The capsule id is here only so a client
 * can tell two apart; it opens nothing while the capsule is sealed.
 */
export interface IncomingMemoryView {
  id: string;
  /** An `occasion` taxonomy key, or the words the host typed. */
  occasion: string;
  unlockAt: Date;
}

export const toIncomingMemoryView = (capsule: MemoryCapsuleDocument): IncomingMemoryView => ({
  id: capsule._id.toString(),
  occasion: capsule.occasion,
  unlockAt: capsule.unlockAt,
});

/** A wish, projected — ONLY ever built for an unlocked capsule. */
export interface MemoryWishView {
  id: string;
  contributorName: string;
  contributorAvatarUrl: string | null;
  kind: string;
  text: string | null;
  mediaUrl: string | null;
  contentType: string | null;
  durationMs: number;
  reactionCount: number;
  createdAt: Date;
}

export interface MemoryShareView {
  slug: string;
  url: string;
  expiresAt: Date | null;
}

/**
 * A reply, projected.
 *
 * Not subject to the time-lock: a reply exists only because a capsule already
 * opened, and it is the author's own words sent deliberately to these people.
 */
export interface MemoryReplyView {
  id: string;
  authorName: string;
  authorAvatarUrl: string | null;
  kind: string;
  text: string | null;
  mediaUrl: string | null;
  contentType: string | null;
  durationMs: number;
  /** How many people it went to, so the author's own copy can say so. */
  recipientCount: number;
  /** Whether the caller wrote it, rather than received it. */
  isMine: boolean;
  createdAt: Date;
}

/** Somebody the caller may reply to, and the memory that entitles them to. */
export interface ReplyAudienceEntry {
  person: PublicIdentity;
  /** Their part in it, for the picker's subtitle: "Host" or "Wrote a wish". */
  isHost: boolean;
  capsuleId: string;
  capsuleTitle: string;
}

export interface MemoryCapsuleView {
  id: string;
  title: string;
  personName: string;

  /**
   * The recipient, resolved. Null for a capsule made before memories were
   * addressed to accounts — [personName] still names them.
   */
  person: PublicIdentity | null;

  relation: string | null;
  occasion: string;
  occasionDate: Date | null;
  includeYear: boolean;
  coverUrl: string | null;
  status: string;
  unlockAt: Date;
  unlockedAt: Date | null;
  timezone: string;
  wishCount: number;

  /**
   * How many of those wishes the viewer wrote.
   *
   * A count, not a boolean: it decides both whether the button reads "Add a
   * Wish" or "Add Another Wish", and whether there is anything of the viewer's
   * own to preview. Safe to show while sealed — it counts only the viewer's
   * own work, which they already know about.
   */
  myWishCount: number;

  /** First names only — the metadata that IS visible while locked. */
  contributors: string[];
  hostId: string;
  /** Whether the caller created it, so the client need not compare ids. */
  isHost: boolean;
  /**
   * Whether the caller is the person it was made for.
   *
   * Its own flag rather than leaving the client to compare `person.userId`
   * against the signed-in id, for the same reason [isHost] is: the capsule view
   * is the only thing several of these screens fetch, and a client that has to
   * cross-reference two providers to answer "is this mine" gets it wrong on the
   * frame where one of them is still loading. It is also what gates replying.
   */
  isRecipient: boolean;
  /**
   * Whether the recipient has shown this memory to the caller. Such a viewer
   * reads the wishes, but it is not theirs: they cannot reply, react or share
   * it on.
   */
  isSharedWithMe: boolean;
  /**
   * Who the recipient has shared it with. Recipient-only — nobody else needs
   * to know who else was shown.
   */
  sharedWith?: PublicIdentity[];
  createdAt: Date;
  // Everything below is empty until `unlocked` — the time-lock.
  wishes: MemoryWishView[];
  /** Host-only: the link that invites people to contribute. */
  share?: MemoryShareView;
}

/** What someone opening the contribute link sees before they have an account. */
export interface PublicMemoryView {
  title: string;
  personName: string;
  occasion: string;
  status: string;
  unlockAt: Date;
  wishCount: number;
  contributors: string[];
  coverUrl: string | null;
}

const firstName = (name: string): string => name.trim().split(/\s+/)[0] || 'A friend';

/** Distinct contributor first names — metadata, safe to show while locked. */
const contributorNames = (wishes: MemoryWishDocument[]): string[] => [
  ...new Set(wishes.map((w) => firstName(w.contributorName))),
];

export const toMemoryReplyView = (
  reply: MemoryReplyDocument,
  viewerId: string,
): MemoryReplyView => ({
  id: reply._id.toString(),
  authorName: reply.authorName,
  authorAvatarUrl: reply.authorAvatarUrl,
  kind: reply.kind,
  text: reply.text,
  mediaUrl: reply.mediaUrl,
  contentType: reply.contentType,
  durationMs: reply.durationMs,
  recipientCount: reply.recipientIds.length,
  isMine: reply.authorId.toString() === viewerId,
  createdAt: reply.createdAt,
});

export const toMemoryWishView = (wish: MemoryWishDocument): MemoryWishView => ({
  id: wish._id.toString(),
  contributorName: wish.contributorName,
  contributorAvatarUrl: wish.contributorAvatarUrl,
  kind: wish.kind,
  text: wish.text,
  mediaUrl: wish.mediaUrl,
  contentType: wish.contentType,
  durationMs: wish.durationMs,
  reactionCount: wish.reactionCount,
  createdAt: wish.createdAt,
});

/**
 * THE time-lock, in one place.
 *
 * Wish content is attached only once the capsule is `unlocked`. Everything
 * else — the title, the count, the contributors' first names — is deliberately
 * visible while it is sealed, because the frames show a locked capsule with
 * "4 Wishes" on it and a countdown. Adding a field to [MemoryCapsuleView] that
 * carries wish content without going through this allowlist is how a surprise
 * leaks; there is no second place to check.
 */
export const toMemoryCapsuleView = (
  capsule: MemoryCapsuleDocument,
  wishes: MemoryWishDocument[],
  opts: {
    viewerId: string | null;
    shareBaseUrl?: string;
    person?: PublicIdentity | null;
    /** Identities for [MemoryCapsule.sharedWith], shown to the recipient only. */
    sharedWith?: PublicIdentity[];
  },
): MemoryCapsuleView => {
  const isHost = opts.viewerId !== null && capsule.hostId.toString() === opts.viewerId;
  const isRecipient =
    opts.viewerId !== null && capsule.recipientUserId?.toString() === opts.viewerId;
  const isSharedWithMe =
    opts.viewerId !== null &&
    !isRecipient &&
    (capsule.sharedWith ?? []).some((id) => id.toString() === opts.viewerId);
  const unlocked = MEMORY_CONTENT_VISIBLE.includes(capsule.status);

  const view: MemoryCapsuleView = {
    id: capsule._id.toString(),
    title: capsule.title,
    personName: capsule.personName,
    person: opts.person ?? null,
    relation: capsule.relation,
    occasion: capsule.occasion,
    occasionDate: capsule.occasionDate,
    includeYear: capsule.includeYear,
    coverUrl: capsule.coverUrl,
    status: capsule.status,
    unlockAt: capsule.unlockAt,
    unlockedAt: capsule.unlockedAt,
    timezone: capsule.timezone,
    wishCount: capsule.wishCount,
    myWishCount:
      opts.viewerId === null
        ? 0
        : wishes.filter((w) => w.contributorId?.toString() === opts.viewerId).length,
    contributors: contributorNames(wishes),
    hostId: capsule.hostId.toString(),
    isHost,
    isRecipient,
    isSharedWithMe,
    ...(isRecipient ? { sharedWith: opts.sharedWith ?? [] } : {}),
    createdAt: capsule.createdAt,
    // The wishes are for the person the memory is *for*, and nobody else —
    // opening the capsule used to hand every wish to every viewer, so a host
    // or a fellow contributor could read what everyone had written to the
    // recipient. Unlocking is what makes the capsule readable *to them*; it is
    // not a general publication. Contributors read their own words back
    // through `/wishes/mine`, which is unaffected.
    //
    // The one widening: people the recipient chose to show it to.
    wishes: unlocked && (isRecipient || isSharedWithMe) ? wishes.map(toMemoryWishView) : [],
  };

  if (isHost && opts.shareBaseUrl) {
    view.share = {
      slug: capsule.share.slug,
      url: `${opts.shareBaseUrl}/m/${capsule.share.slug}`,
      expiresAt: capsule.share.expiresAt,
    };
  }
  return view;
};

/**
 * The unauthenticated view a contribute link resolves to.
 *
 * Never carries wish content, in any status — this surface exists so someone
 * can *add* a wish, and the recipient may well be holding the phone.
 */
export const toPublicMemoryView = (
  capsule: MemoryCapsuleDocument,
  wishes: MemoryWishDocument[],
): PublicMemoryView => ({
  title: capsule.title,
  personName: capsule.personName,
  occasion: capsule.occasion,
  status: capsule.status,
  unlockAt: capsule.unlockAt,
  wishCount: capsule.wishCount,
  contributors: contributorNames(wishes),
  coverUrl: capsule.coverUrl,
});

/** A capsule is open once the job has flipped it, never merely by the clock. */
export const isUnlocked = (capsule: MemoryCapsuleDocument): boolean =>
  capsule.status === MemoryStatus.UNLOCKED;
