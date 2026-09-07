import { ReelStatus, WishKind } from './reel.types';
import type { ReelCollectionDocument } from './schemas/reel-collection.schema';
import type { WishDocument } from './schemas/wish.schema';

/** A wish, projected — ONLY ever built for a released reel. */
export interface ReelWishView {
  id: string;
  authorName: string;
  kind: string;
  text: string | null;
}

export interface ReelShareView {
  slug: string;
  url: string;
  hasPasscode: boolean;
  expiresAt: Date | null;
}

export interface ReelCollectionView {
  id: string;
  title: string;
  recipientUserId: string;
  initiatorId: string;
  eventId: string | null;
  status: string;
  releaseAt: Date;
  submissionDeadline: Date;
  wishCount: number;
  /** First names only — the metadata that IS visible while locked. */
  contributors: string[];
  shareCount: number;
  createdAt: Date;
  // Everything below is null/absent until `released` — the time-lock.
  reelMediaUrl: string | null;
  durationMs: number | null;
  ogImageUrl: string | null;
  wishes: ReelWishView[];
  share?: ReelShareView;
}

export interface PublicReelView {
  title: string;
  status: string;
  releaseAt: Date;
  wishCount: number;
  contributors: string[];
  reelMediaUrl: string | null;
  ogImageUrl: string | null;
}

const firstName = (name: string): string => name.trim().split(/\s+/)[0] || 'A friend';

/** Distinct contributor first names — metadata, safe to show while locked. */
const contributorNames = (wishes: WishDocument[]): string[] => [
  ...new Set(wishes.map((w) => firstName(w.authorName))),
];

/**
 * THE time-lock, in one place. Wish content and the reel URL are attached only
 * when the collection is `released`; before that, every caller gets counts and
 * first names and nothing else — no endpoint can accidentally leak content
 * because there is no code path here that projects it while locked.
 */
export function toReelView(input: {
  collection: ReelCollectionDocument;
  wishes: WishDocument[];
  canManage: boolean;
  shareBaseUrl: string;
}): ReelCollectionView {
  const { collection, wishes, canManage, shareBaseUrl } = input;
  const released = collection.status === ReelStatus.RELEASED;

  const view: ReelCollectionView = {
    id: collection._id.toString(),
    title: collection.title,
    recipientUserId: collection.recipientUserId.toString(),
    initiatorId: collection.initiatorId.toString(),
    eventId: collection.eventId ? collection.eventId.toString() : null,
    status: collection.status,
    releaseAt: collection.releaseAt,
    submissionDeadline: collection.submissionDeadline,
    wishCount: collection.wishCount,
    contributors: contributorNames(wishes),
    shareCount: collection.shareCount,
    createdAt: collection.createdAt,
    reelMediaUrl: released ? collection.reelMediaUrl : null,
    durationMs: released ? collection.durationMs : null,
    ogImageUrl: released ? collection.ogImageUrl : null,
    wishes: released
      ? wishes.map((w) => ({
          id: w._id.toString(),
          authorName: w.authorName,
          kind: w.kind,
          text: w.kind === WishKind.TEXT ? w.text : null,
        }))
      : [],
  };
  if (canManage) {
    view.share = {
      slug: collection.share.slug,
      url: `${shareBaseUrl}/r/${collection.share.slug}`,
      hasPasscode: collection.share.passcodeHash !== null,
      expiresAt: collection.share.expiresAt,
    };
  }
  return view;
}

export function toPublicReelView(
  collection: ReelCollectionDocument,
  wishes: WishDocument[],
): PublicReelView {
  const released = collection.status === ReelStatus.RELEASED;
  return {
    title: collection.title,
    status: collection.status,
    releaseAt: collection.releaseAt,
    wishCount: collection.wishCount,
    contributors: contributorNames(wishes),
    reelMediaUrl: released ? collection.reelMediaUrl : null,
    ogImageUrl: released ? collection.ogImageUrl : null,
  };
}
