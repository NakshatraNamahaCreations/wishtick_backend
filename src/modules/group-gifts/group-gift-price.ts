import type { WishlistItemDocument } from 'src/modules/wishlists/schemas/wishlist-item.schema';
import { GroupGiftStatus } from './group-gift.types';
import type { GroupGiftDocument } from './schemas/group-gift.schema';

/**
 * Price tracking for a group gift: when the shop's price for something in the
 * bill moves, the host is told and decides what to do. The goal never moves on
 * its own — people pledged against a number, and changing it under them is the
 * host's call to make and to explain.
 *
 * Pure: everything here is a function of the gift and its items, so the rules
 * are unit-tested without a database and the view and the listener cannot
 * disagree about what counts as a change.
 */

/** A move smaller than this is noise, not news: ₹50. */
export const PRICE_MOVE_FLOOR_MINOR = 50_00;

/** …or 2% of the price, whichever is larger — ₹50 on a ₹40,000 phone is nothing. */
export const PRICE_MOVE_SHARE = 0.02;

/** Only a gift still collecting, or collected and not yet bought, is watched. */
export const PRICE_WATCHED_STATUSES: GroupGiftStatus[] = [
  GroupGiftStatus.OPEN,
  GroupGiftStatus.FUNDED,
];

/** Whether going from [fromMinor] to [toMinor] is worth telling anyone about. */
export function isSignificantMove(fromMinor: number, toMinor: number): boolean {
  const moved = Math.abs(toMinor - fromMinor);
  if (moved === 0) return false;
  return moved >= Math.max(PRICE_MOVE_FLOOR_MINOR, Math.round(fromMinor * PRICE_MOVE_SHARE));
}

/** One item in the bill whose shop price no longer matches what the bill was built on. */
export interface PriceAlertView {
  itemId: string;
  /** The extra gift's line, or null for the primary item. */
  lineId: string | null;
  title: string;
  /** The shop price the bill was built on. */
  pricedAtMinor: number;
  /** What the shop asks now; null when it is out of stock with no price. */
  currentMinor: number | null;
  /** current − pricedAt: negative is cheaper. Null when there is no price. */
  deltaMinor: number | null;
  outOfStock: boolean;
  /** When the shop was last asked. */
  checkedAt: Date | null;
  /** What using the new price would do to the money; null with no price. */
  effect?: PriceEffect | null;
}

/**
 * The shop price an item's share of the bill was built on.
 *
 * Recorded once the host applies a new price. Before that: the price the line
 * was added at, or — for the primary item — the item's own snapshot, which the
 * nightly sync never rewrites. Not the item's share of the goal: a host may
 * have set a goal above the price (wrapping, a card), and comparing the shop
 * against that would report a change that never happened.
 */
export function pricedAtFor(
  gift: GroupGiftDocument,
  itemId: string,
  item: WishlistItemDocument | undefined,
): number | null {
  const recorded = (gift.priceBaselines ?? []).find((b) => b.itemId.toString() === itemId);
  if (recorded) return recorded.amountMinor;
  const line = gift.lines.find((l) => l.itemId.toString() === itemId);
  if (line && line.amountMinor !== null) return line.amountMinor;
  return item?.price?.amountMinor ?? null;
}

/**
 * Every item in the bill whose price has moved enough, or that has gone out of
 * stock, and that the host has not already waved off at that same price.
 *
 * Empty for a gift that is not watched — once it is being bought, the price
 * the shop charged is the one that counts.
 */
export function priceAlertsFor(
  gift: GroupGiftDocument,
  items: Map<string, WishlistItemDocument>,
): PriceAlertView[] {
  if (!PRICE_WATCHED_STATUSES.includes(gift.status)) return [];

  const rows: { itemId: string; lineId: string | null }[] = [
    { itemId: gift.itemId.toString(), lineId: null },
    ...gift.lines.map((l) => ({ itemId: l.itemId.toString(), lineId: l._id.toString() })),
  ];

  const alerts: PriceAlertView[] = [];
  for (const { itemId, lineId } of rows) {
    const item = items.get(itemId);
    const source = item?.sourceAlert;
    if (!item || !source) continue;

    const pricedAt = pricedAtFor(gift, itemId, item);
    if (pricedAt === null) continue;

    // Only a price the sync actually saw move counts — a bare snapshot with no
    // change recorded beside it is the price the bill was built on.
    const current = source.priceChangedAt ? source.currentAmountMinor : null;
    const moved = current !== null && isSignificantMove(pricedAt, current);
    const outOfStock = source.outOfStock === true;
    if (!moved && !outOfStock) continue;

    const dismissed = (gift.priceDismissals ?? []).some(
      (d) =>
        d.itemId.toString() === itemId &&
        d.currentMinor === (moved ? current : null) &&
        d.outOfStock === outOfStock,
    );
    if (dismissed) continue;

    alerts.push({
      itemId,
      lineId,
      title: item.title,
      pricedAtMinor: pricedAt,
      currentMinor: moved ? current : null,
      deltaMinor: moved ? current - pricedAt : null,
      outOfStock,
      checkedAt: source.checkedAt ?? null,
    });
  }
  return alerts;
}

/**
 * What "Use the new price" would do to the money, worked out before the host
 * presses it, so the card can say so.
 */
export interface PriceEffect {
  /** The goal with the new price. */
  newTargetMinor: number;
  /** What the host would owe the group back. */
  refundMinor: number;
  /** Refunds raised and not sent yet that would no longer be needed. */
  cancelledRefundMinor: number;
  /** What the group would still need to put in. */
  askMinor: number;
}

/**
 * The money side of applying [deltaMinor], by the same rule
 * `SettlementService.rebalanceAfterPriceChange` follows: unsent refunds are
 * called off, then the new goal is set against what the host holds —
 * collected, less refunds already sent.
 */
export function priceEffect(input: {
  targetMinor: number;
  collectedMinor: number;
  sentRefundMinor: number;
  pendingRefundMinor: number;
  deltaMinor: number;
}): PriceEffect {
  const newTargetMinor = Math.max(0, input.targetMinor + input.deltaMinor);
  const held = input.collectedMinor - input.sentRefundMinor;
  const after = held - newTargetMinor;
  const refundMinor = Math.max(0, after);
  return {
    newTargetMinor,
    refundMinor,
    // Called off in full, then raised again for what is still extra — so
    // what is no longer needed is the part that is not raised again.
    cancelledRefundMinor: Math.max(0, input.pendingRefundMinor - refundMinor),
    askMinor: Math.max(0, -after),
  };
}

/** "₹1,999" — or "₹1,999.50" when there are paise. */
export function rupees(minor: number): string {
  const whole = minor % 100 === 0;
  return `₹${(minor / 100).toLocaleString('en-IN', {
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: whole ? 0 : 2,
  })}`;
}
