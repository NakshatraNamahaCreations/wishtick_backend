import type { WishlistItemDocument } from 'src/modules/wishlists/schemas/wishlist-item.schema';
import type { ContributionDocument } from './schemas/contribution.schema';
import type { GroupGiftDocument } from './schemas/group-gift.schema';

/** A named member of the group gift. Anonymous contributors never appear here. */
export interface ParticipantView {
  userId: string;
  name: string;
}

/** One contribution on the timeline. `contributor` is null when it was anonymous. */
export interface ContributionView {
  id: string;
  amountMinor: number;
  message: string | null;
  anonymous: boolean;
  createdAt: Date;
  contributor: ParticipantView | null;
}

export interface GroupGiftShareView {
  slug: string;
  url: string;
  hasPasscode: boolean;
  expiresAt: Date | null;
}

/** A non-item cost folded into the group's total (`4007:568`). */
export interface GroupGiftChargeView {
  id: string;
  label: string;
  amountMinor: number;
  addedBy: string;
  addedAt: Date;
}

/** An additional item beyond the primary one (`4007:720`). */
export interface GroupGiftLineView {
  id: string;
  itemId: string;
  amountMinor: number | null;
  addedAt: Date;
}

/**
 * One row of "Selected Gifts (N)" (`4007:801`) — everything that screen draws,
 * already ordered primary-first.
 *
 * Assembled here rather than left to the client because the primary item lives
 * on `gift.itemId` while the extras live in `gift.lines`: every client would
 * otherwise re-derive the same concatenation, and each would have to decide
 * separately that the primary is the one you cannot remove.
 */
export interface GroupGiftItemView {
  /** The line id, or null for the primary item — which has no line. */
  lineId: string | null;
  itemId: string;
  title: string;
  imageUrl: string | null;
  amountMinor: number | null;
  /**
   * False for the primary item: dropping it would leave a group gift for
   * nothing, so the design offers cancel instead (`4007:801` shows the × on
   * extras only).
   */
  removable: boolean;
}

export interface GroupGiftView {
  id: string;
  itemId: string;
  wishlistId: string;
  status: string;
  /** The host's name for it, e.g. "Siya's birthday gift". */
  title: string;
  /**
   * Who started it. Needed so the participant list can badge them "Host"
   * (`316:536`) — `share` only tells the *caller* whether they are the host,
   * which cannot label anyone else.
   */
  hostId: string;
  /** Where members send their share. Wishtick never holds the money. */
  hostUpiId: string | null;
  contributionMode: string;
  /** The chips the host offers on the contribute sheet. Minor units. */
  suggestedAmountsMinor: number[];
  /** The Grand Total: every gift plus every charge. What the group collects. */
  targetAmountMinor: number;
  /** The charges' share of the target, so the summary need not re-add them. */
  chargesTotalMinor: number;
  charges: GroupGiftChargeView[];
  lines: GroupGiftLineView[];
  /** "Selected Gifts (N)" — primary first, then the extras. */
  items: GroupGiftItemView[];
  collectedAmountMinor: number;
  currency: string;
  percentFunded: number;
  contributorCount: number;
  participantCount: number;
  deadline: Date | null;
  overfundPolicy: string;
  visibility: string;
  message: string | null;
  ogImageUrl: string | null;
  chatId: string | null;
  /**
   * Who the gift is for. Signs the thank-you card (`2219:603`) and names the
   * group elsewhere. Null when the item cannot be resolved.
   */
  recipientName: string | null;
  /** The recipient's thank-you note (`2219:603`), once they have written it. */
  thankYouNote: string | null;
  thankYouAt: Date | null;
  createdAt: Date;
  participants: ParticipantView[];
  recentContributions: ContributionView[];
  myContributionMinor: number;
  /** Present only for the initiator/manager. */
  share?: GroupGiftShareView;
}

/** The redacted public share view — no owner PII, no wishlist internals. */
export interface PublicGroupGiftView {
  status: string;
  targetAmountMinor: number;
  collectedAmountMinor: number;
  currency: string;
  percentFunded: number;
  contributorCount: number;
  deadline: Date | null;
  message: string | null;
  ogImageUrl: string | null;
  participants: ParticipantView[];
  recentContributions: ContributionView[];
}

/**
 * A person's name, already resolved by the caller.
 *
 * Was `user.name`, which phone signup never sets — the name people actually
 * type lands on their profile's `displayName` — so every participant and every
 * contributor rendered as "A friend".
 */
const displayName = (names: Map<string, string>, userId: string): string =>
  names.get(userId)?.trim() || 'A friend';

/** Clamp to [0,100]; a capped over-target group never shows more than 100%. */
const percent = (collected: number, target: number): number =>
  target <= 0 ? 0 : Math.min(100, Math.round((collected / target) * 100));

/**
 * Builds a contribution timeline entry, withholding the contributor's identity
 * when the contribution was anonymous. This is the single place that decides
 * whether a name is revealed, so no projection can accidentally leak one.
 */
const toContributionView = (
  c: ContributionDocument,
  names: Map<string, string>,
): ContributionView => ({
  id: c._id.toString(),
  amountMinor: c.amountMinor,
  message: c.message,
  anonymous: c.anonymous,
  createdAt: c.createdAt,
  contributor: c.anonymous
    ? null
    : { userId: c.userId.toString(), name: displayName(names, c.userId.toString()) },
});

const toParticipants = (gift: GroupGiftDocument, names: Map<string, string>): ParticipantView[] =>
  gift.participantIds.map((id) => ({
    userId: id.toString(),
    name: displayName(names, id.toString()),
  }));

/**
 * Builds the "Selected Gifts" list. An item the caller cannot resolve is still
 * listed — a deleted item must not make the rest of the bill disappear — but
 * it is named plainly rather than dropped, so the total still adds up on
 * screen.
 */
const toItemViews = (
  gift: GroupGiftDocument,
  items: Map<string, WishlistItemDocument>,
): GroupGiftItemView[] => {
  const row = (
    itemId: string,
    lineId: string | null,
    amountMinor: number | null,
  ): GroupGiftItemView => {
    const item = items.get(itemId);
    return {
      lineId,
      itemId,
      title: item?.title ?? 'Unavailable item',
      imageUrl: item?.imageUrls?.[0] ?? null,
      amountMinor: amountMinor ?? item?.price?.amountMinor ?? null,
      removable: lineId !== null,
    };
  };
  return [
    row(gift.itemId.toString(), null, null),
    ...gift.lines.map((line) => row(line.itemId.toString(), line._id.toString(), line.amountMinor)),
  ];
};

/**
 * Just enough to say "a group is already collecting for this", on the item
 * screen that would otherwise offer to reserve it, buy it, or start a second
 * one -- all three of which the server refuses with a 409.
 */
export interface ItemGroupGiftView {
  id: string;
  title: string;
  status: string;
  currency: string;
  targetAmountMinor: number;
  collectedAmountMinor: number;
  percentFunded: number;
  contributorCount: number;
}

export function toGroupGiftView(input: {
  gift: GroupGiftDocument;
  names: Map<string, string>;
  items: Map<string, WishlistItemDocument>;
  recentContributions: ContributionDocument[];
  myContributionMinor: number;
  canManage: boolean;
  shareBaseUrl: string;
}): GroupGiftView {
  const { gift, names, items, recentContributions, myContributionMinor, canManage, shareBaseUrl } =
    input;
  const view: GroupGiftView = {
    id: gift._id.toString(),
    itemId: gift.itemId.toString(),
    wishlistId: gift.wishlistId.toString(),
    status: gift.status,
    title: gift.title,
    hostId: gift.initiatorId.toString(),
    hostUpiId: gift.hostUpiId,
    contributionMode: gift.contributionMode,
    suggestedAmountsMinor: gift.suggestedAmountsMinor,
    // The Grand Total off the summary screen. Charges are agreed before the
    // first contribution, so this *is* the target rather than something on top
    // of it — see GroupGiftService.recomputeTarget.
    targetAmountMinor: gift.targetAmountMinor,
    chargesTotalMinor: gift.charges.reduce((sum, charge) => sum + charge.amountMinor, 0),
    charges: gift.charges.map((charge) => ({
      id: charge._id.toString(),
      label: charge.label,
      amountMinor: charge.amountMinor,
      addedBy: charge.addedBy.toString(),
      addedAt: charge.addedAt,
    })),
    lines: gift.lines.map((line) => ({
      id: line._id.toString(),
      itemId: line.itemId.toString(),
      amountMinor: line.amountMinor,
      addedAt: line.addedAt,
    })),
    items: toItemViews(gift, items),
    collectedAmountMinor: gift.collectedAmountMinor,
    currency: gift.currency,
    // Progress stays measured against the *target* the group set, not the true
    // cost: a charge added at checkout must not make an already-full bar look
    // like it went backwards. The shortfall shows up in the balance instead.
    percentFunded: percent(gift.collectedAmountMinor, gift.targetAmountMinor),
    contributorCount: gift.contributorCount,
    participantCount: gift.participantIds.length,
    deadline: gift.deadline,
    overfundPolicy: gift.overfundPolicy,
    visibility: gift.visibility,
    message: gift.message,
    ogImageUrl: gift.ogImageUrl,
    chatId: gift.chatId ? gift.chatId.toString() : null,
    recipientName: (() => {
      const primary = items.get(gift.itemId.toString());
      return primary ? displayName(names, primary.ownerId.toString()) : null;
    })(),
    thankYouNote: gift.thankYouNote,
    thankYouAt: gift.thankYouAt,
    createdAt: gift.createdAt,
    participants: toParticipants(gift, names),
    recentContributions: recentContributions.map((c) => toContributionView(c, names)),
    myContributionMinor,
  };
  if (canManage) {
    view.share = {
      slug: gift.share.slug,
      url: `${shareBaseUrl}/g/${gift.share.slug}`,
      hasPasscode: gift.share.passcodeHash !== null,
      expiresAt: gift.share.expiresAt,
    };
  }
  return view;
}

export function toPublicGroupGiftView(input: {
  gift: GroupGiftDocument;
  names: Map<string, string>;
  recentContributions: ContributionDocument[];
}): PublicGroupGiftView {
  const { gift, names, recentContributions } = input;
  return {
    status: gift.status,
    targetAmountMinor: gift.targetAmountMinor,
    collectedAmountMinor: gift.collectedAmountMinor,
    currency: gift.currency,
    percentFunded: percent(gift.collectedAmountMinor, gift.targetAmountMinor),
    contributorCount: gift.contributorCount,
    deadline: gift.deadline,
    message: gift.message,
    ogImageUrl: gift.ogImageUrl,
    participants: toParticipants(gift, names),
    recentContributions: recentContributions.map((c) => toContributionView(c, names)),
  };
}
