import { Types } from 'mongoose';
import type { WishlistItemDocument } from 'src/modules/wishlists/schemas/wishlist-item.schema';
import { isSignificantMove, priceAlertsFor, priceEffect, rupees } from './group-gift-price';
import { GroupGiftStatus } from './group-gift.types';
import type { GroupGiftDocument } from './schemas/group-gift.schema';

const primaryId = new Types.ObjectId();
const lineItemId = new Types.ObjectId();
const lineId = new Types.ObjectId();

/** Just the fields the rules read. */
const gift = (over: Partial<Record<string, unknown>> = {}): GroupGiftDocument =>
  ({
    status: GroupGiftStatus.OPEN,
    itemId: primaryId,
    lines: [],
    priceBaselines: [],
    priceDismissals: [],
    ...over,
  }) as unknown as GroupGiftDocument;

const item = (
  id: Types.ObjectId,
  snapshotMinor: number,
  alert: { current?: number | null; outOfStock?: boolean } | null,
): WishlistItemDocument =>
  ({
    _id: id,
    title: id === primaryId ? 'Headphones' : 'Speaker',
    price: { amountMinor: snapshotMinor, currency: 'INR' },
    sourceAlert: alert
      ? {
          priceChangedAt: alert.current === undefined ? null : new Date('2026-10-14'),
          currentAmountMinor: alert.current ?? null,
          outOfStock: alert.outOfStock ?? false,
          checkedAt: new Date('2026-10-14'),
        }
      : null,
  }) as unknown as WishlistItemDocument;

const itemsOf = (...docs: WishlistItemDocument[]) =>
  new Map(docs.map((d) => [d._id.toString(), d]));

describe('isSignificantMove', () => {
  it('ignores anything under ₹50', () => {
    expect(isSignificantMove(1_000_00, 1_049_99)).toBe(false);
    expect(isSignificantMove(1_000_00, 1_050_00)).toBe(true);
    expect(isSignificantMove(1_000_00, 950_00)).toBe(true);
  });

  it('asks for 2% on a dear item, where ₹50 is nothing', () => {
    // 2% of ₹40,000 is ₹800.
    expect(isSignificantMove(40_000_00, 40_799_00)).toBe(false);
    expect(isSignificantMove(40_000_00, 40_800_00)).toBe(true);
    expect(isSignificantMove(40_000_00, 39_200_00)).toBe(true);
  });

  it('a price that did not move is not a move', () => {
    expect(isSignificantMove(0, 0)).toBe(false);
    expect(isSignificantMove(1_999_00, 1_999_00)).toBe(false);
  });
});

describe('priceAlertsFor', () => {
  it('raises a drop on the primary item against its own snapshot', () => {
    const [alert] = priceAlertsFor(
      gift(),
      itemsOf(item(primaryId, 2_499_00, { current: 1_999_00 })),
    );
    expect(alert).toMatchObject({
      itemId: primaryId.toString(),
      lineId: null,
      pricedAtMinor: 2_499_00,
      currentMinor: 1_999_00,
      deltaMinor: -500_00,
      outOfStock: false,
    });
  });

  it('measures an extra gift from the price it was added at', () => {
    const [alert] = priceAlertsFor(
      gift({ lines: [{ _id: lineId, itemId: lineItemId, amountMinor: 3_000_00 }] }),
      itemsOf(item(primaryId, 2_499_00, null), item(lineItemId, 2_800_00, { current: 3_500_00 })),
    );
    expect(alert).toMatchObject({
      lineId: lineId.toString(),
      pricedAtMinor: 3_000_00,
      deltaMinor: 500_00,
    });
  });

  it('measures from the price the host last moved the bill to', () => {
    const repriced = gift({ priceBaselines: [{ itemId: primaryId, amountMinor: 1_999_00 }] });
    // The shop still asks what the host already followed it to: nothing to say.
    expect(
      priceAlertsFor(repriced, itemsOf(item(primaryId, 2_499_00, { current: 1_999_00 }))),
    ).toEqual([]);
    // It moves again: measured from ₹1,999, not the old snapshot.
    const [again] = priceAlertsFor(
      repriced,
      itemsOf(item(primaryId, 2_499_00, { current: 2_199_00 })),
    );
    expect(again).toMatchObject({ pricedAtMinor: 1_999_00, deltaMinor: 200_00 });
  });

  it('stays quiet about a move too small to matter', () => {
    expect(
      priceAlertsFor(gift(), itemsOf(item(primaryId, 2_499_00, { current: 2_480_00 }))),
    ).toEqual([]);
  });

  it('raises out of stock even when the price did not move', () => {
    const [alert] = priceAlertsFor(
      gift(),
      itemsOf(item(primaryId, 2_499_00, { outOfStock: true })),
    );
    expect(alert).toMatchObject({ outOfStock: true, currentMinor: null, deltaMinor: null });
  });

  it('forgets an alert the host dismissed — until the price moves again', () => {
    const dismissed = gift({
      priceDismissals: [{ itemId: primaryId, currentMinor: 1_999_00, outOfStock: false }],
    });
    expect(
      priceAlertsFor(dismissed, itemsOf(item(primaryId, 2_499_00, { current: 1_999_00 }))),
    ).toEqual([]);
    expect(
      priceAlertsFor(dismissed, itemsOf(item(primaryId, 2_499_00, { current: 1_799_00 }))),
    ).toHaveLength(1);
  });

  it('stops watching once the gift is being bought', () => {
    for (const status of [
      GroupGiftStatus.PURCHASING,
      GroupGiftStatus.PURCHASED,
      GroupGiftStatus.CANCELLED,
    ]) {
      expect(
        priceAlertsFor(gift({ status }), itemsOf(item(primaryId, 2_499_00, { current: 99_00 }))),
      ).toEqual([]);
    }
  });
});

describe('priceEffect — the owner’s three rules, before anything is pressed', () => {
  const base = { targetMinor: 3_499_00, sentRefundMinor: 0, pendingRefundMinor: 0 };

  it('a drop with everything paid leaves the host owing the excess back', () => {
    expect(priceEffect({ ...base, collectedMinor: 3_499_00, deltaMinor: -500_00 })).toEqual({
      newTargetMinor: 2_999_00,
      refundMinor: 500_00,
      cancelledRefundMinor: 0,
      askMinor: 0,
    });
  });

  it('the price coming back before the refund is sent means no refund', () => {
    expect(
      priceEffect({
        ...base,
        targetMinor: 2_999_00,
        collectedMinor: 3_499_00,
        pendingRefundMinor: 500_00,
        deltaMinor: 500_00,
      }),
    ).toEqual({
      newTargetMinor: 3_499_00,
      refundMinor: 0,
      cancelledRefundMinor: 500_00,
      askMinor: 0,
    });
  });

  it('a rise after the refund was made asks the group for more', () => {
    // ₹500 went back, so the host holds ₹2,999 against a ₹3,499 gift again.
    expect(
      priceEffect({ ...base, targetMinor: 2_999_00, collectedMinor: 2_999_00, deltaMinor: 500_00 }),
    ).toEqual({
      newTargetMinor: 3_499_00,
      refundMinor: 0,
      cancelledRefundMinor: 0,
      askMinor: 500_00,
    });
  });

  it('a refund on its way counts as gone', () => {
    // Sent but not yet confirmed: the host no longer has it.
    expect(
      priceEffect({
        ...base,
        targetMinor: 2_999_00,
        collectedMinor: 3_499_00,
        sentRefundMinor: 500_00,
        deltaMinor: 500_00,
      }).askMinor,
    ).toBe(500_00);
  });

  it('a partial return keeps part of the refund', () => {
    expect(
      priceEffect({
        ...base,
        targetMinor: 2_999_00,
        collectedMinor: 3_499_00,
        pendingRefundMinor: 500_00,
        deltaMinor: 200_00,
      }),
    ).toMatchObject({ refundMinor: 300_00, cancelledRefundMinor: 200_00, askMinor: 0 });
  });
});

describe('rupees', () => {
  it('reads as people write it', () => {
    expect(rupees(1_999_00)).toBe('₹1,999');
    expect(rupees(1_50_000_00)).toBe('₹1,50,000');
    expect(rupees(1_999_50)).toBe('₹1,999.50');
  });
});
