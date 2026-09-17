import type { AddressView } from 'src/modules/profile/addresses.service';
import type { WishlistItemDocument } from './schemas/wishlist-item.schema';
import type { WishlistDocument } from './schemas/wishlist.schema';
import type { AccessDecision } from './access/access.types';
import { BOUGHT_ITEM_STATUSES, WishlistItemStatus } from './wishlist.types';
import type { ItemImportance, WishlistVisibility } from './wishlist.types';

/**
 * An item that has been bought, as one viewer may see it. Null on an item
 * nobody has bought — a reservation included, which keeps its ordinary look.
 *
 * What it says depends on who is asking:
 *  - the person the list is for learns only that it is taken ([by], and
 *    [mine] for their own "got it myself") — never who, never how;
 *  - the buyer gets [mine], to undo it or change whether they are named;
 *  - everyone else gets [buyerName] only if the buyer chose to show it.
 */
export interface ItemLockView {
  /** `owner` for the owner's own "I got this myself", otherwise `gifter`. */
  by: 'gifter' | 'owner';
  /** The buyer's first name, when they chose to show it and the viewer may see it. */
  buyerName: string | null;
  /** Present when the viewer is the one who bought it. */
  mine: { giftId: string; showName: boolean } | null;
}

/** Who is looking at an item, for [toItemView]. */
export interface ItemViewer {
  userId?: string | null;
  /**
   * The person the list is for: its owner, or the WishMate a list made by
   * somebody else names. Sees surprises masked and never learns a buyer.
   */
  isRecipient: boolean;
  /** First names by user id, for buyers who chose to be named. */
  buyerNames?: Map<string, string>;
}

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
  /** Set once the item is bought — what greys it out. See [ItemLockView]. */
  lock: ItemLockView | null;
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
  /**
   * Where to send a gift, when one is attached *and* this caller may see it.
   *
   * Three distinguishable states, because the client renders each differently:
   * `undefined` — this caller may not see the address (say so to nobody);
   * `null` — they may, and none is attached ("add a delivery address");
   * an address — show it. Gated by
   * [AccessPolicyService.canViewAddress], not by `access.canView`.
   */
  address?: AddressView | null;

  /**
   * Whether this caller may change that address.
   *
   * Not derivable from `access.canManage`: an owner loses the decision while
   * their list sits on somebody else's event, because approving it handed the
   * address to that event's host. Sent so a client does not have to re-derive
   * a rule it cannot see all the inputs to, and does not offer a button whose
   * every press would 409.
   *
   * Accompanies `address`, so it is present on the detail read and absent from
   * the list endpoints, which show neither.
   */
  canSetAddress?: boolean;
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
  /**
   * Set once it is bought. A buyer's name appears only for a signed-in viewer
   * who is not the person the list is for — never to an anonymous link.
   */
  lock: ItemLockView | null;
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
 * The lock one viewer sees on [item], or null while it is not bought.
 *
 * Shared by the signed-in and share-link projections so the rule about who
 * learns a buyer's name lives in one place.
 */
export const toItemLock = (item: WishlistItemDocument, viewer: ItemViewer): ItemLockView | null => {
  if (!BOUGHT_ITEM_STATUSES.includes(item.status)) return null;

  const buyerId = item.activeGiftBuyerId?.toString() ?? null;
  const giftId = item.activeGiftId?.toString() ?? null;
  const isMine = Boolean(viewer.userId && buyerId && buyerId === viewer.userId);
  const byOwner = item.activeGiftByOwner === true;
  const named =
    !viewer.isRecipient && !isMine && !byOwner && item.activeGiftShowName === true && buyerId;

  return {
    by: byOwner ? 'owner' : 'gifter',
    buyerName: named ? (viewer.buyerNames?.get(buyerId) ?? null) : null,
    mine: isMine && giftId ? { giftId, showName: byOwner ? false : item.activeGiftShowName } : null,
  };
};

/** The buyers whose names [items] may show, for one batched name lookup. */
export const namedBuyerIds = (items: WishlistItemDocument[]): string[] => [
  ...new Set(
    items
      .filter((i) => i.activeGiftShowName && i.activeGiftBuyerId && !i.activeGiftByOwner)
      .map((i) => i.activeGiftBuyerId!.toString()),
  ),
];

/**
 * Projects an item for one viewer.
 *
 * The person the list is for sees a surprise masked: a hidden reservation as
 * `available`, and a hidden purchase as plain `purchased` — greyed, but not
 * saying whether it was bought here or elsewhere. Everyone else sees the true
 * status, so duplicate gifting is still prevented. No view carries a gifter's
 * id; a name appears only through [toItemLock].
 */
export const toItemView = (
  item: WishlistItemDocument,
  viewer: ItemViewer = { isRecipient: false },
): ItemView => {
  const hidden = viewer.isRecipient && item.activeGiftVisibility === 'hidden_from_owner';
  const status = !hidden
    ? item.status
    : BOUGHT_ITEM_STATUSES.includes(item.status)
      ? WishlistItemStatus.PURCHASED
      : WishlistItemStatus.AVAILABLE;
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
    status,
    lock: toItemLock(item, viewer),
    position: item.position,
    createdAt: item.createdAt,
    sourceProductId: item.sourceProductId?.toString() ?? null,
  };
};

/**
 * `delivery` is passed in already resolved rather than looked up here: both
 * halves of it are async policy questions, and a view projection is the wrong
 * place to be making authorization decisions. Omit it entirely for a caller
 * who may not see the address — see [WishlistView.address].
 */
export const toWishlistView = (
  wishlist: WishlistDocument,
  access: AccessDecision,
  shareBaseUrl?: string,
  delivery?: { address: AddressView | null; canSet: boolean },
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
  if (delivery) {
    view.address = delivery.address;
    view.canSetAddress = delivery.canSet;
  }
  return view;
};
