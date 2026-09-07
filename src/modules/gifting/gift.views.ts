import type { GiftDocument } from './schemas/gift.schema';
import type { GiftMode, GiftStatus, GiftType } from './gift.types';

export interface GiftView {
  id: string;
  itemId: string;
  wishlistId: string;
  type: GiftType;
  mode: GiftMode;
  status: GiftStatus;
  amountMinor: number | null;
  currency: string;
  deliveryNotes: string | null;
  reservedAt: Date | null;
  expiresAt: Date | null;
  createdAt: Date;
  /** Present only when the viewer is the gifter. */
  history?: { status: GiftStatus; at: Date; note: string | null }[];
}

/**
 * A gift as the OWNER (recipient) is allowed to see it.
 *
 * This is the projection behind "the owner's view never reveals who reserved
 * their item". It carries no gifterId, no history (history rows name the
 * gifter), and no reservation timing that could out them — only the fact that a
 * gift exists, and only when the gift is not hidden from them.
 */
export interface RecipientGiftView {
  id: string;
  itemId: string;
  status: GiftStatus;
  mode: GiftMode;
  createdAt: Date;
}

export const toGifterView = (gift: GiftDocument): GiftView => ({
  id: gift._id.toString(),
  itemId: gift.itemId.toString(),
  wishlistId: gift.wishlistId.toString(),
  type: gift.type,
  mode: gift.mode,
  status: gift.status,
  amountMinor: gift.amountMinor,
  currency: gift.currency,
  deliveryNotes: gift.deliveryNotes,
  reservedAt: gift.reservedAt,
  expiresAt: gift.expiresAt,
  createdAt: gift.createdAt,
  history: gift.history.map((h) => ({ status: h.status, at: h.at, note: h.note })),
});

export const toRecipientView = (gift: GiftDocument): RecipientGiftView => ({
  id: gift._id.toString(),
  itemId: gift.itemId.toString(),
  status: gift.status,
  mode: gift.mode,
  createdAt: gift.createdAt,
});

/**
 * A gift as one row of "Gifts Given" / "Received" / "On Hold"
 * (`324:1253`, `324:1108`, `324:1210`).
 *
 * The bare [GiftView] carries ids only, which is right for the gifting flow but
 * useless to a list screen: every one of those frames shows the item's photo,
 * its title and its price, who it is for or from, and where the delivery got
 * to. Assembling that per row on the client would be four round-trips a card.
 */
export interface GiftListItemView {
  id: string;
  itemId: string;
  wishlistId: string;
  type: GiftType;
  mode: GiftMode;
  status: GiftStatus;
  /** True for a group gift — the "Group Gift" chip, and the Group tab. */
  isGroup: boolean;
  item: {
    title: string;
    imageUrl: string | null;
    amountMinor: number | null;
    currency: string;
  };
  /**
   * "For Rohan" on a gift you gave, "From Rohan" on one you received.
   *
   * Null when naming them would give something away — see [toGiftListItemView]
   * and the recipient-side rule in gifting.service.
   */
  counterpartyName: string | null;
  /** From the linked order, when there is one. */
  deliveredAt: Date | null;
  /** Where the reservation stands, for the "Held for 1d 3h" chip. */
  expiresAt: Date | null;
  /** Whether the recipient has already thanked the gifter (`324:1108`). */
  thankYouSent: boolean;
  createdAt: Date;
}
