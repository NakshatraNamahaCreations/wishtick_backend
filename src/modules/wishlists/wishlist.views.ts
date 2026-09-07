import type { WishlistItemDocument } from './schemas/wishlist-item.schema';
import type { WishlistDocument } from './schemas/wishlist.schema';
import type { AccessDecision } from './access/access.types';
import { WishlistItemStatus } from './wishlist.types';
import type { ItemImportance, WishlistVisibility } from './wishlist.types';

export interface ItemView {
  id: string;
  title: string;
  notes: string | null;
  recipientName: string | null;
  relation: string | null;
  occasionKey: string | null;
  imageUrls: string[];
  productLink: string | null;
  price: { amountMinor: number | null; currency: string };
  category: string | null;
  priority: number;
  importance: ItemImportance;
  quantity: number;
  giftPreferences: { color: string | null; size: string | null; variantNotes: string | null };
  status: WishlistItemStatus;
  position: number;
  createdAt: Date;

  /**
   * The catalogue row this item was imported from, or null for one added by
   * hand.
   *
   * The item's own title/price/image are a snapshot taken at import and stay
   * frozen — this does not change that. It is the handle a *detail* screen
   * needs to fetch the things a snapshot never carried: the seller, the
   * rating, the other sellers, the specification table. Fetch it through
   * `GET /products/id/:productId`.
   *
   * An id rather than `provider`/`externalId` because those live on the
   * product, not the item: returning them would mean joining the products
   * collection for every item of every list, to serve one screen that shows
   * one item.
   */
  sourceProductId: string | null;
}

export interface WishlistView {
  id: string;
  title: string;
  description: string | null;
  occasionLabel: string | null;
  visibility: WishlistVisibility;
  coverUrl: string | null;
  chatEnabled: boolean;
  eventId: string | null;
  forUserId: string | null;
  stats: { itemCount: number; fulfilledCount: number };
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  /** What the *current caller* may do. Clients render from this, not from roles. */
  access: AccessDecision;
  /** Owner-only. Absent for everyone else. */
  share?: { slug: string; url: string; hasPasscode: boolean; expiresAt: Date | null };
}

/** The unauthenticated share-link view. Deliberately a different, smaller shape. */
export interface PublicWishlistView {
  title: string;
  description: string | null;
  coverUrl: string | null;
  /** First name only — enough to say "Aarav's list", not enough to identify. */
  ownerFirstName: string | null;
  itemCount: number;
  items: PublicItemView[];
}

export interface PublicItemView {
  id: string;
  title: string;
  notes: string | null;
  imageUrls: string[];
  productLink: string | null;
  price: { amountMinor: number | null; currency: string };
  category: string | null;
  priority: number;
  importance: ItemImportance;
  quantity: number;
  giftPreferences: { color: string | null; size: string | null; variantNotes: string | null };
  /**
   * Whether someone has already claimed this item — but never *who*.
   *
   * Collapsing every claimed status to a boolean is deliberate: the point is to
   * stop duplicate gifting, and "reserved vs purchased vs shipped" is the
   * gifter's business. It also keeps a stranger from watching the list to work
   * out who bought what.
   */
  isClaimed: boolean;
}

export interface OpenGraphPreview {
  title: string;
  description: string;
  image: string | null;
  url: string;
  type: 'website';
  siteName: 'Wishtick';
}

/**
 * Projects an item.
 *
 * `maskForOwner` hides a surprise from the wishlist owner: when the item's
 * active gift is `hidden_from_owner`, the owner sees it as `available` rather
 * than `reserved`/`purchased`. Other viewers always pass `false` and see the
 * true, claimed status (so duplicate gifting is still prevented). Only the
 * *status* is masked — the view never carried a gifter identity to leak.
 */
export const toItemView = (item: WishlistItemDocument, maskForOwner = false): ItemView => {
  const hidden = maskForOwner && item.activeGiftVisibility === 'hidden_from_owner';
  return {
    id: item._id.toString(),
    title: item.title,
    notes: item.notes,
    recipientName: item.recipientName,
    relation: item.relation,
    occasionKey: item.occasionKey,
    imageUrls: item.imageUrls,
    productLink: item.productLink,
    price: {
      amountMinor: item.price?.amountMinor ?? null,
      currency: item.price?.currency ?? 'INR',
    },
    category: item.category,
    priority: item.priority,
    importance: item.importance,
    quantity: item.quantity,
    giftPreferences: {
      color: item.giftPreferences?.color ?? null,
      size: item.giftPreferences?.size ?? null,
      variantNotes: item.giftPreferences?.variantNotes ?? null,
    },
    status: hidden ? WishlistItemStatus.AVAILABLE : item.status,
    position: item.position,
    createdAt: item.createdAt,
    sourceProductId: item.sourceProductId?.toString() ?? null,
  };
};

export const toWishlistView = (
  wishlist: WishlistDocument,
  access: AccessDecision,
  shareBaseUrl?: string,
): WishlistView => {
  const view: WishlistView = {
    id: wishlist._id.toString(),
    title: wishlist.title,
    description: wishlist.description,
    occasionLabel: wishlist.occasionLabel,
    visibility: wishlist.visibility,
    coverUrl: wishlist.coverUrl,
    chatEnabled: wishlist.chatEnabled,
    eventId: wishlist.eventId?.toString() ?? null,
    forUserId: wishlist.forUserId?.toString() ?? null,
    stats: {
      itemCount: wishlist.stats?.itemCount ?? 0,
      fulfilledCount: wishlist.stats?.fulfilledCount ?? 0,
    },
    archivedAt: wishlist.archivedAt,
    createdAt: wishlist.createdAt,
    updatedAt: wishlist.updatedAt,
    access,
  };

  // The slug is a credential: anyone holding it can open an unlisted list, so
  // it is returned only to the person entitled to hand it out.
  if (access.canManage && shareBaseUrl) {
    view.share = {
      slug: wishlist.share.slug,
      url: `${shareBaseUrl}/w/${wishlist.share.slug}`,
      hasPasscode: wishlist.share.passcodeHash !== null,
      expiresAt: wishlist.share.expiresAt,
    };
  }
  return view;
};
